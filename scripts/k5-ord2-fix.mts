// ════════════════════════════════════════════════════════════════════════════
// LATAIF — K5: einmalige, idempotente Korrektur von ORD-2026-00002 (Owner-Freigabe nötig, Apps geschlossen).
//
// Vorbedingung: die neue Version (K1–K4, OF3) ist installiert und am Primary EINMAL gestartet (Startmigrationen:
// gold_payables.book_value, gold_payable_settlements, products.origin_*), danach Primary und PC2 geschlossen.
//
// Was korrigiert wird (Preview V4 §8, Owner-Daten):
//   A  Order-Datum, Fertigstellung und Kopf-„Deposit date" → 2026-10-25 (K4-Hausfolge + Protokoll).
//   B  Kartengebühr EXP-2026-000005 (5,760 BHD, Normal 2,4 % von 240) → Tag 2026-10-25, Betrag gleich
//      („Edit Expense" der App: Buchung storniert und am neuen Tag gegen das Karten-Clearing neu gebucht).
//   C  Lohn 25,000 BHD: Lager an Lieferantenschuld Arup am 2026-10-25, genau einmal; Goldschuld 4,330 g 21K bleibt,
//      Wertbuchung Lager 185,000 an GOLD_LIABILITY · Arup am 2026-10-25 (K1 `commitOrderLineExpenses`, idempotent).
// Unverändert: Zero 0 %, 240,000, Status completed, die Kartenzahlung 240 vom 25.10. (Banking), keine Rechnung,
// kein Artikel, kein Goldbestand. Danach erstellt der Owner die Rechnung in der App.
//
// Es läuft der ECHTE Code der App (dieselben Hausfolgen wie die Masken) auf der Datei — in EINER Klammer. Jede
// Abweichung vom erwarteten Stand vorher oder nachher → Rücknahme, die Datei bleibt unberührt.
//
// Aufruf:   node --experimental-strip-types scripts/k5-ord2-fix.mts <lataif.db> [--apply]
//   ohne --apply: nur Plan und Prüfungen (nichts wird geschrieben).
//   --apply: anwenden; die Datei wird atomar ersetzt (temp + rename). Zweiter Lauf: „NICHTS ZU TUN".
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
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

const args = process.argv.slice(2);
const DB_PATH = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const UNBEKANNT = args.filter((a) => a.startsWith('--') && a !== '--apply');
if (!DB_PATH || UNBEKANNT.length) { console.error('Aufruf: node --experimental-strip-types scripts/k5-ord2-fix.mts <lataif.db> [--apply]'); process.exit(2); }
if (!existsSync(DB_PATH)) { console.error(`Datei fehlt: ${DB_PATH}`); process.exit(2); }

// Die Sitzung des Owners am Primary — und, wie in der Produktion, ein eingerichteter Abgleich (Änderungsliste).
const ACTOR = { branchId: 'branch-main', userId: 'user-owner' };
const store = new Map<string, string>([
  ['lataif_session', JSON.stringify(ACTOR)], ['lataif_sync_url', 'k5-offline'], ['lataif_sync_token', 'k5-offline'],
]);
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../test/sync/_db-shim.ts');
const { installWriteGuard } = await import('../src/core/db/write-guard.ts');
const posting = await import('../src/core/ledger/posting.ts');
const { useAuthStore } = await import('../src/stores/authStore.ts');
const { useOrderStore } = await import('../src/stores/orderStore.ts');
const { updateOrderDatesInHouse } = await import('../src/core/orders/order-dates.ts');
const { updateExpenseInHouse } = await import('../src/core/payables/payables-house.ts');
const { unbookedOrderCosts } = await import('../src/core/orders/order-cost-booking.ts');
const { correctionDateIssue } = await import('../src/core/ledger/correction-dates.ts');
const { logAuditOrThrow } = await import('../src/core/audit/audit-log.ts');

// ── Die festen Daten (Kopie der Produktions-DB vom 06.11.2026, nur gelesen) ──
const DAY = '2026-10-25';
const ORDER = '5350f37b-4060-4992-a1aa-937230abb219';
const ORDER_NR = 'ORD-2026-00002';
const CUSTOMER = '4370527e-daf8-4866-89ef-454367f282fe';
const LINE_CUSTOM = 'cb936235-1cbe-405f-97ef-b276e37f1946';
const LINE_LABOR = '033244ff-3fb2-4611-9a3e-7ef255514d8f';
const LINE_GOLD = 'ee92f87b-ba57-48f1-b08c-073a24278eca';
const ARUP = '08116742-f08f-42d3-b674-c9e41aea1d62';
const PAYMENT = '2d8bb587-51ef-485b-91ba-cb5bbef18e1f';
const PAYABLE = '1118bcee-71cc-4794-a0ff-af14d6d60ff2';
const FEE = 'f7606951-b525-4a04-be82-af1f735f21fd';        // EXP-2026-000005 (gültig)
const FEE_OLD = 'c29ed9b9-ead0-4bcb-bce8-c4f94304b17c';    // EXP-2026-000004 (storniert, bleibt)
const ALT = { orderDate: '2026-11-05', depositDate: '2026-11-05', feeDate: '2026-11-05' };

const S = JSON.stringify;
const r3 = (x: unknown): number => Math.round((Number(x) || 0) * 1000) / 1000;
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
class Abbruch extends Error {}
const fail = (m: string): never => { throw new Abbruch(m); };

const bytesVorher = readFileSync(DB_PATH);
const shaVorher = sha(bytesVorher);
const db = new SQL.Database(bytesVorher) as unknown as {
  run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array; close(): void;
};
setTestDatabase(db as never);
installWriteGuard(db as never);
useAuthStore.setState({ session: { userId: ACTOR.userId, branchId: ACTOR.branchId, role: 'OWNER' } as never });

function q(sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
}
const one = (sql: string, p: unknown[] = []) => q(sql, p)[0];
const hasCol = (t: string, c: string) => q(`PRAGMA table_info(${t})`).some((x) => x.name === c);
const hasTable = (t: string) => q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t]).length > 0;
const net = (where: string, p: unknown[] = []) => r3(one(`SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) AS n FROM ledger_entries WHERE ${where}`, p)?.n);

/** Jede Tabelle als Zeilen-Fingerabdruck (Schlüssel → Hash) — für den Vollvergleich vorher/nachher. */
function snapshot(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const t of q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name))) {
    const key = hasCol(t, 'id') ? 'id' : 'rowid';
    const m = new Map<string, string>();
    for (const r of q(`SELECT ${key} AS __k, * FROM "${t}"`)) { const k = String(r.__k); delete r.__k; m.set(k, sha(S(r))); }
    out.set(t, m);
  }
  return out;
}
function diff(a: Map<string, Map<string, string>>, b: Map<string, Map<string, string>>) {
  const res: Record<string, { neu: string[]; weg: string[]; geaendert: string[] }> = {};
  for (const [t, mb] of b) {
    const ma = a.get(t) ?? new Map();
    const neu = [...mb.keys()].filter((k) => !ma.has(k));
    const weg = [...ma.keys()].filter((k) => !mb.has(k));
    const geaendert = [...mb.keys()].filter((k) => ma.has(k) && ma.get(k) !== mb.get(k));
    if (neu.length || weg.length || geaendert.length) res[t] = { neu, weg, geaendert };
  }
  for (const t of a.keys()) if (!b.has(t)) res[t] = { neu: [], weg: [...a.get(t)!.keys()], geaendert: [] };
  return res;
}

type Status = 'KORREKTUR' | 'BEREITS' | 'ABBRUCH';
interface Schritt { art: 'A' | 'B' | 'C'; status: Status; detail: string }

// ── Plan: Stand je Schritt (nur lesend) ──
function planA(o: Record<string, unknown>): Schritt {
  const felder = [
    ['order_date', String(o.order_date ?? ''), ALT.orderDate],
    ['actual_delivery', String(o.actual_delivery ?? ''), ''],
    ['deposit_date', String(o.deposit_date ?? ''), ALT.depositDate],
  ] as const;
  const offen = felder.filter(([, ist]) => ist !== DAY);
  if (offen.length === 0) return { art: 'A', status: 'BEREITS', detail: `Order-Datum, Fertigstellung, Deposit date = ${DAY}` };
  const fremd = offen.filter(([, ist, alt]) => ist !== alt);
  if (fremd.length) return { art: 'A', status: 'ABBRUCH', detail: `unerwartet: ${fremd.map(([f, ist]) => `${f}=${ist || 'leer'}`).join(', ')}` };
  return { art: 'A', status: 'KORREKTUR', detail: offen.map(([f, ist]) => `${f} ${ist || 'leer'} → ${DAY}`).join(', ') };
}
function planB(): Schritt {
  const e = one('SELECT * FROM expenses WHERE id = ?', [FEE]);
  const pay = one('SELECT created_at FROM order_payments WHERE id = ?', [PAYMENT]);
  if (!e || e.expense_number !== 'EXP-2026-000005' || e.category !== 'CardFees' || r3(e.amount) !== 5.76 || e.status !== 'PAID'
    || e.related_module !== 'order' || e.related_entity_id !== ORDER || !pay || e.created_at !== pay.created_at) {
    return { art: 'B', status: 'ABBRUCH', detail: `Kartengebühr weicht ab: ${S(e && { nr: e.expense_number, cat: e.category, amt: e.amount, st: e.status, created: e.created_at })}` };
  }
  const live = net("source_module = 'EXPENSE' AND source_id = ? AND account = 'EXPENSES_OPERATING'", [FEE]);
  const amTag = net("source_module = 'EXPENSE' AND source_id = ? AND account = 'EXPENSES_OPERATING' AND substr(occurred_at, 1, 10) = ?", [FEE, DAY]);
  if (e.expense_date === DAY) {
    return live === 5.76 && amTag === 5.76
      ? { art: 'B', status: 'BEREITS', detail: `EXP-2026-000005 5,760 am ${DAY} gebucht` }
      : { art: 'B', status: 'ABBRUCH', detail: `Datum ${DAY}, aber Buchung live ${live} / am Tag ${amTag}` };
  }
  if (e.expense_date !== ALT.feeDate || live !== 5.76) return { art: 'B', status: 'ABBRUCH', detail: `Datum ${e.expense_date}, Buchung live ${live}` };
  return { art: 'B', status: 'KORREKTUR', detail: `EXP-2026-000005 5,760: ${ALT.feeDate} → ${DAY} (Betrag gleich, gegen Karten-Clearing neu gebucht)` };
}
function planC(): Schritt {
  const lab = one('SELECT * FROM order_lines WHERE id = ?', [LINE_LABOR]);
  const gp = one('SELECT * FROM gold_payables WHERE id = ?', [PAYABLE]);
  const teile: string[] = [];
  let korr = false;
  if (!lab || lab.supplier_id !== ARUP || r3(lab.cost_amount) !== 25 || !['ARRIVED', 'DELIVERED'].includes(String(lab.status))) {
    return { art: 'C', status: 'ABBRUCH', detail: `Lohnzeile weicht ab: ${S(lab && { sup: lab.supplier_id, cost: lab.cost_amount, st: lab.status })}` };
  }
  if (!lab.expense_id) { korr = true; teile.push('Lohn 25,000: Lager an Lieferantenschuld Arup'); }
  else {
    const e = one('SELECT * FROM expenses WHERE id = ?', [String(lab.expense_id)]);
    const inv = net("source_module = 'EXPENSE' AND source_id = ? AND account = 'INVENTORY' AND substr(occurred_at, 1, 10) = ?", [String(lab.expense_id), DAY]);
    if (!e || r3(e.amount) !== 25 || e.supplier_id !== ARUP || e.category !== 'Inventory' || e.status === 'CANCELLED' || inv !== 25) {
      return { art: 'C', status: 'ABBRUCH', detail: `Lohn-A/P weicht ab: ${S(e && { amt: e.amount, sup: e.supplier_id, cat: e.category, st: e.status })}, Lager am Tag ${inv}` };
    }
    teile.push('Lohn-A/P schon gebucht');
  }
  if (!gp || gp.direction !== 'we_owe' || Number(gp.weight_grams) !== 4.33 || gp.karat !== '21K' || gp.supplier_id !== ARUP
    || gp.source_order_line_id !== LINE_GOLD || !hasCol('gold_payables', 'book_value')) {
    return { art: 'C', status: 'ABBRUCH', detail: `Goldschuld weicht ab: ${S(gp && { dir: gp.direction, g: gp.weight_grams, k: gp.karat, sup: gp.supplier_id })}` };
  }
  if (gp.book_value === null || gp.book_value === undefined) {
    if (gp.status !== 'OPEN' || Number(gp.fulfilled_grams) !== 0) return { art: 'C', status: 'ABBRUCH', detail: `Goldschuld nicht offen: ${gp.status} ${gp.fulfilled_grams}` };
    korr = true; teile.push('Goldwert 185,000: Lager an GOLD_LIABILITY Arup');
  } else {
    const inv = net("source_module = 'GOLD_PAYABLE' AND source_id = ? AND account = 'INVENTORY' AND substr(occurred_at, 1, 10) = ?", [PAYABLE, DAY]);
    if (r3(gp.book_value) !== 185 || gp.book_value_date !== DAY || inv !== 185) return { art: 'C', status: 'ABBRUCH', detail: `Goldwert weicht ab: ${gp.book_value} ${gp.book_value_date} Lager ${inv}` };
    teile.push('Goldwert schon gebucht');
  }
  return { art: 'C', status: korr ? 'KORREKTUR' : 'BEREITS', detail: `${teile.join('; ')} (am ${DAY})` };
}

/** Was VOR dem Anwenden gelten muss — Auftrag, Zeilen, Zahlung, Goldschuld, Schema, offene Periode. */
function vorbedingungen(o: Record<string, unknown>): string[] {
  const f: string[] = [];
  for (const [t, c] of [['gold_payables', 'book_value'], ['gold_payables', 'book_value_date'], ['products', 'origin_type'], ['gold_payable_settlements', 'cost_mode']] as const) {
    if (!(hasTable(t) && hasCol(t, c))) f.push(`Schema ${t}.${c} fehlt — die neue Version ist am Primary noch nicht einmal gestartet`);
  }
  if (o.order_number !== ORDER_NR || o.type !== 'custom' || o.status !== 'completed' || o.customer_id !== CUSTOMER || r3(o.agreed_price) !== 240
    || o.invoice_id || o.product_id || o.category_id !== 'cat-gold-jewelry') {
    f.push(`Auftrag weicht ab: ${S({ nr: o.order_number, type: o.type, st: o.status, kunde: o.customer_id, preis: o.agreed_price, inv: o.invoice_id, prod: o.product_id, cat: o.category_id })}`);
  }
  const lines = q('SELECT id, status, material_kind, is_customer_facing, unit_price, tax_scheme, vat_rate, cost_amount, supplier_id, invoice_id, product_id FROM order_lines WHERE order_id = ? ORDER BY position', [ORDER]);
  const c = lines.find((l) => l.id === LINE_CUSTOM);
  if (lines.length !== 3 || !c || c.material_kind !== 'custom' || c.tax_scheme !== 'ZERO' || Number(c.vat_rate) !== 0 || r3(c.unit_price) !== 240
    || c.invoice_id || c.product_id || c.status !== 'DELIVERED' || !lines.some((l) => l.id === LINE_GOLD && r3(l.cost_amount) === 185 && !l.supplier_id && l.status === 'DELIVERED')) {
    f.push(`Positionen weichen ab: ${S(lines)}`);
  }
  const pays = q('SELECT id, amount, method, card_brand, paid_at, converted_to_invoice FROM order_payments WHERE order_id = ?', [ORDER]);
  if (pays.length !== 1 || pays[0].id !== PAYMENT || r3(pays[0].amount) !== 240 || pays[0].method !== 'card' || pays[0].card_brand !== 'normal'
    || pays[0].paid_at !== DAY || Number(pays[0].converted_to_invoice) !== 0) f.push(`Anzahlung weicht ab: ${S(pays)}`);
  if (net("source_module = 'ORDER_PAYMENT' AND source_id = ? AND account = 'CUSTOMER_DEPOSITS'", [PAYMENT]) !== -240
    || net("source_module = 'ORDER_PAYMENT' AND source_id = ? AND account = 'CARD_CLEARING' AND substr(occurred_at, 1, 10) = ?", [PAYMENT, DAY]) !== 240) {
    f.push('Buchung der Anzahlung (Karte 240 am 25.10. an Kundenanzahlungen) weicht ab');
  }
  if (hasTable('gold_payable_settlements') && q('SELECT 1 FROM gold_payable_settlements WHERE payable_id = ?', [PAYABLE]).length) f.push('Goldschuld hat schon Begleichungen');
  if (hasTable('order_deposit_applications') && q('SELECT 1 FROM order_deposit_applications WHERE order_id = ?', [ORDER]).length) f.push('Anzahlung schon angerechnet');
  const alt = one('SELECT status FROM expenses WHERE id = ?', [FEE_OLD]);
  if (!alt || alt.status !== 'CANCELLED' || net("source_module = 'EXPENSE' AND source_id = ?", [FEE_OLD]) !== 0) f.push('EXP-2026-000004 ist nicht (gebucht-neutral) storniert');
  const tag = correctionDateIssue(ACTOR.branchId, [{ iso: DAY, what: 'K5' }] as never);
  if (tag) f.push(`Buchungstag ${DAY} gesperrt: ${tag.message}`);
  return f;
}

// ── Ablauf ──
let exitCode = 0;
try {
  const integ = String(one('PRAGMA integrity_check')?.integrity_check);
  if (integ !== 'ok') fail(`integrity_check vorher: ${integ}`);
  const o = one('SELECT * FROM orders WHERE id = ?', [ORDER]);
  if (!o) fail(`Auftrag ${ORDER_NR} nicht gefunden`);
  const plan = [planA(o!), planB(), planC()];
  console.log(`K5 ${ORDER_NR} — Datei ${DB_PATH} (sha256 ${shaVorher.slice(0, 16)}…)`);
  for (const p of plan) console.log(`  ${p.art} ${p.status}: ${p.detail}`);
  if (plan.every((p) => p.status === 'BEREITS')) {
    console.log('NICHTS ZU TUN: alles bereits korrigiert (idempotent) — Datei unverändert');
  } else {
    if (plan.some((p) => p.status === 'ABBRUCH')) fail('ein Schritt weicht vom erwarteten Stand ab — nichts geändert');
    const vb = vorbedingungen(o!);
    for (const v of vb) console.log(`  Vorbedingung: ${v}`);
    if (vb.length) fail('Vorbedingungen nicht erfüllt — nichts geändert');
    if (!APPLY) {
      console.log(`PLAN: ${plan.filter((p) => p.status === 'KORREKTUR').length} Schritt(e) — ohne --apply nichts geschrieben`);
    } else {
      const vor = snapshot();
      const saldoVor = (acc: string, extra = '') => net(`account = '${acc}'${extra}`);
      const kontenVor = q("SELECT account, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS s FROM ledger_entries GROUP BY account");
      const arupApVor = saldoVor('ACCOUNTS_PAYABLE', ` AND counterparty_id = '${ARUP}'`);
      const arupGoldVor = saldoVor('GOLD_LIABILITY', ` AND counterparty_id = '${ARUP}'`);
      const nowIso = new Date().toISOString();
      posting.beginLedgerTransaction();
      try {
        const check = posting.watchLedgerPosts('k5.ord2');
        // A — Daten (K4-Hausfolge) + Kopf-„Deposit date" = Tag der ersten Zahlung (K2-Regel), protokolliert.
        if (plan[0].status === 'KORREKTUR') {
          updateOrderDatesInHouse(ORDER, { orderDate: DAY, completedOn: DAY }, ACTOR.branchId, ACTOR);
          const dep = String(one('SELECT deposit_date FROM orders WHERE id = ?', [ORDER])?.deposit_date ?? '');
          if (dep !== DAY) {
            useOrderStore.getState().updateOrder(ORDER, { depositDate: DAY } as never);
            logAuditOrThrow({ module: 'Order', entityType: 'orders', entityId: ORDER, action: 'UPDATE', field: 'deposit_date', oldValue: dep, newValue: DAY, actor: ACTOR });
          }
        }
        // B — Kartengebühr auf den Zahlungstag („Edit Expense" der App).
        if (plan[1].status === 'KORREKTUR') {
          updateExpenseInHouse(FEE, { expenseDate: DAY }, { branchId: ACTOR.branchId, userId: ACTOR.userId, now: nowIso });
        }
        // C — Lohn-A/P und Goldwert, genau einmal (K1, idempotent je Zeile/Schuld).
        if (plan[2].status === 'KORREKTUR') {
          useOrderStore.getState().commitOrderLineExpenses(ORDER, { bookingDate: DAY });
        }
        check();

        // ── Nachprüfung in der Klammer ──
        const nach = snapshot();
        const d = diff(vor, nach);
        const erlaubt = new Set(['orders', 'order_lines', 'expenses', 'gold_payables', 'ledger_entries', 'audit_log', 'sync_changelog', 'document_sequences', 'ledger_sequence']);
        for (const [t, x] of Object.entries(d)) {
          if (!erlaubt.has(t)) fail(`unerwartet geändert: ${t} ${S({ neu: x.neu.length, weg: x.weg.length, geaendert: x.geaendert.length })}`);
          if (x.weg.length) fail(`${t}: Zeilen entfernt (${x.weg.length})`);
        }
        const exp = (t: string, neu: number, geaendert: string[]) => {
          const x = d[t] ?? { neu: [], weg: [], geaendert: [] };
          if (x.neu.length !== neu || S([...x.geaendert].sort()) !== S([...geaendert].sort())) fail(`${t}: ${x.neu.length} neu / geändert ${S(x.geaendert)} — erwartet ${neu} / ${S(geaendert)}`);
        };
        const A = plan[0].status === 'KORREKTUR', B = plan[1].status === 'KORREKTUR', C = plan[2].status === 'KORREKTUR';
        // Die Auftragszeile ändert sich durch A (Daten) und durch C (Fassung folgt der Positionsänderung).
        exp('orders', 0, A || C ? [ORDER] : []);
        const lohnNeu = C && plan[2].detail.includes('Lohn 25,000');
        const goldNeu = C && plan[2].detail.includes('Goldwert 185,000');
        exp('order_lines', 0, lohnNeu ? [LINE_LABOR] : []);
        exp('expenses', lohnNeu ? 1 : 0, B ? [FEE] : []);
        exp('gold_payables', 0, goldNeu ? [PAYABLE] : []);
        exp('ledger_entries', (lohnNeu ? 2 : 0) + (goldNeu ? 2 : 0) + (B ? 4 : 0), []);
        // Salden: nur Lager, Lieferantenschuld Arup und Goldschuld Arup bewegen sich; alles andere bleibt.
        const kontenNach = new Map(q("SELECT account, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS s FROM ledger_entries GROUP BY account").map((r) => [String(r.account), r3(r.s)]));
        const delta = new Map<string, number>();
        for (const r of kontenVor) delta.set(String(r.account), r3((kontenNach.get(String(r.account)) ?? 0) - r3(r.s)));
        for (const [k, v] of kontenNach) if (!delta.has(k)) delta.set(k, v);
        const soll: Record<string, number> = { INVENTORY: (lohnNeu ? 25 : 0) + (goldNeu ? 185 : 0), ACCOUNTS_PAYABLE: lohnNeu ? -25 : 0, GOLD_LIABILITY: goldNeu ? -185 : 0 };
        for (const [k, v] of delta) if (r3(v) !== r3(soll[k] ?? 0)) fail(`Saldo ${k} ändert sich um ${v} statt ${soll[k] ?? 0}`);
        if (net('1 = 1') !== 0) fail('Hauptbuch nicht ausgeglichen');
        if (r3(net(`account = 'ACCOUNTS_PAYABLE' AND counterparty_id = '${ARUP}'`) - arupApVor) !== (lohnNeu ? -25 : 0)) fail('Lieferantenschuld Arup weicht ab');
        if (r3(net(`account = 'GOLD_LIABILITY' AND counterparty_id = '${ARUP}'`) - arupGoldVor) !== (goldNeu ? -185 : 0)) fail('Goldschuld Arup (BHD) weicht ab');
        // Ergebnis: Daten, Gebühr am Tag, Lohn-A/P offen, Goldschuld offen mit Buchwert, Anzahlung offen, nichts verkauft.
        const o2 = one('SELECT order_date, actual_delivery, deposit_date, status, invoice_id, product_id FROM orders WHERE id = ?', [ORDER])!;
        if (o2.order_date !== DAY || o2.actual_delivery !== DAY || o2.deposit_date !== DAY || o2.status !== 'completed' || o2.invoice_id || o2.product_id) fail(`Auftrag danach: ${S(o2)}`);
        if (planB().status !== 'BEREITS') fail('Kartengebühr danach nicht am Tag');
        if (planC().status !== 'BEREITS') fail('Lohn/Gold danach nicht gebucht');
        const lohn = one('SELECT e.* FROM expenses e JOIN order_lines l ON l.expense_id = e.id WHERE l.id = ?', [LINE_LABOR]);
        if (!lohn || lohn.status !== 'PENDING' || r3(lohn.paid_amount) !== 0 || lohn.payment_method !== 'bank' || lohn.expense_date !== DAY) fail(`Lohn-A/P danach: ${S(lohn)}`);
        const gp = one('SELECT status, fulfilled_grams, weight_grams, book_value FROM gold_payables WHERE id = ?', [PAYABLE])!;
        if (gp.status !== 'OPEN' || Number(gp.fulfilled_grams) !== 0 || Number(gp.weight_grams) !== 4.33 || r3(gp.book_value) !== 185) fail(`Goldschuld danach: ${S(gp)}`);
        if (net("account = 'CUSTOMER_DEPOSITS' AND counterparty_id = ?", [CUSTOMER]) !== -240) fail('Kundenanzahlung nicht mehr 240 offen');
        if (unbookedOrderCosts(ORDER).length) fail(`nicht gebuchte Kosten danach: ${S(unbookedOrderCosts(ORDER))}`);
        const integ2 = String(one('PRAGMA integrity_check')?.integrity_check);
        if (integ2 !== 'ok') fail(`integrity_check nachher: ${integ2}`);
        posting.commitLedgerTransaction();
        console.log(`  geändert: ${Object.entries(d).map(([t, x]) => `${t} +${x.neu.length}/~${x.geaendert.length}`).join(', ')}`);
      } catch (e) {
        try { posting.rollbackLedgerTransaction(); } catch { /* schon zu */ }
        throw e;
      }
      // Datei atomar ersetzen: temp + fsync + rename; danach frisch lesen und prüfen.
      const bytes = db.export();
      const tmp = `${DB_PATH}.k5-tmp`;
      writeFileSync(tmp, Buffer.from(bytes));
      const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd);
      renameSync(tmp, DB_PATH);
      const neu = readFileSync(DB_PATH);
      const pruef = new SQL.Database(neu) as unknown as { exec(sql: string): Array<{ values: unknown[][] }>; close(): void };
      const integ3 = String(pruef.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0]);
      pruef.close();
      if (integ3 !== 'ok') fail(`integrity_check der geschriebenen Datei: ${integ3}`);
      console.log(`ANGEWENDET: sha256 ${shaVorher.slice(0, 16)}… → ${sha(neu).slice(0, 16)}… (${statSync(DB_PATH).size} Bytes), integrity ok`);
    }
  }
} catch (e) {
  console.error('ABBRUCH:', e instanceof Abbruch ? e.message : e);
  exitCode = 1;
} finally {
  try { db.close(); } catch { /* zu */ }
}
process.exit(exitCode);
