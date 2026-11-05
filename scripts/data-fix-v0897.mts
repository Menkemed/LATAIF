// ════════════════════════════════════════════════════════════════════════════
// LATAIF v0.8.97 — einmalige, idempotente Datenkorrektur (Owner-Freigabe nötig, App geschlossen).
//
//   A  VAN-BGJ-005 / VAN-BGJ-006: der Altbestand, den der erste Einkauf am 03.11.2026 (PUR-2026-000024, noch ohne den
//      F1-Fix) überschrieben hat, kommt als eigenes Los zurück — genau so, wie v0.8.97 (F1, `lotForLotlessOldStock`)
//      ihn bei diesem Einkauf angelegt hätte: Los ohne Einkauf und ohne Buchung, Einstand = historischer Einstand,
//      `acquired_at` = Eingangstag des Artikels (FIFO: die alten Stücke gehen zuerst). Menge = Σ Lose. Das Einkaufslos,
//      sein Einstand, der Einkauf und das Hauptbuch bleiben unverändert.
//      Gezählt (Owner, endgültig): VAN-BGJ-005 7 Stück (ERP 4), VAN-BGJ-006 2 Stück (ERP 1).
//      Einstand alt (Owner, endgültig bestätigt 05.11.2026): VAN-BGJ-005 3 × 190 BHD (= products.purchase_price seit 20.10.,
//      Wingold Jewe-13148), VAN-BGJ-006 1 × 140 BHD (Wingold Jewe-13127). Fest im Skript — es gibt keinen Schalter dafür.
//   B  Gold-Diamond: das aus den Diamant-Zeilen abgeleitete Diamond Weight wird gespeichert, wo es fehlt (kanonische
//      Steinlogik `normalizeStoneAttributes`). Nur `attributes.diamond_weight` kommt dazu; Steinzeilen, Preise, VAT,
//      Mengen, Buchungen, `updated_at` und alle anderen Merkmale bleiben, wie sie sind. Diamantzeilen ohne Karat →
//      Prüfbedarf, nichts wird erfunden.
//
// Aufruf:   node scripts/data-fix-v0897.mts <lataif.db> [--apply] [--only=A|B]
//   ohne --apply: nur Plan und Prüfungen, die Datei wird NICHT geöffnet zum Schreiben.
//   Alles in EINER Transaktion; jede Abweichung vom erwarteten Stand → ROLLBACK, nichts geändert.
// ════════════════════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const st = await import('../src/core/products/stones.ts');

const args = process.argv.slice(2);
const DB = args.find((a) => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const ONLY = (args.find((a) => a.startsWith('--only=')) || '').slice(7).toUpperCase();
if (!DB) { console.error('Aufruf: node scripts/data-fix-v0897.mts <lataif.db> [--apply] [--only=A|B]'); process.exit(2); }
const UNBEKANNT = args.filter((a) => a.startsWith('--') && a !== '--apply' && !a.startsWith('--only='));
if (UNBEKANNT.length) { console.error(`Unbekannte Schalter: ${UNBEKANNT.join(' ')} (die Einstände stehen fest im Skript)`); process.exit(2); }

const NOW = new Date().toISOString();
const ACTOR = 'user-owner';
const S = JSON.stringify;
const db = new DatabaseSync(DB, { readOnly: !APPLY });
const q = (sql: string, p: unknown[] = []) => db.prepare(sql).all(...(p as never[])) as Array<Record<string, unknown>>;
const one = (sql: string, p: unknown[] = []) => q(sql, p)[0];
const run = (sql: string, p: unknown[] = []) => db.prepare(sql).run(...(p as never[]));
const sha = (v: unknown) => createHash('sha256').update(S(v)).digest('hex').slice(0, 16);
class Abbruch extends Error {}
const fail = (m: string): never => { throw new Abbruch(m); };

// ── Fingerabdruck: was die Korrektur NICHT anfassen darf ─────────────────────
function fingerprint() {
  const t = (name: string, order = 'rowid') => sha(q(`SELECT * FROM ${name} ORDER BY ${order}`));
  return {
    ledger: one('SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(amount),0), 3) AS s FROM ledger_entries'),
    purchases: t('purchases'), purchase_lines: t('purchase_lines'), invoices: t('invoices'), invoice_lines: t('invoice_lines'),
    payments: t('payments'), stock_adjustments: t('stock_adjustments'), expenses: t('expenses'),
  };
}
const productRows = () => new Map(q('SELECT * FROM products').map((r) => [String(r.id), r]));
const lotRows = () => new Map(q('SELECT * FROM stock_lots').map((r) => [String(r.id), r]));

function audit(entityType: string, entityId: string, action: string, field: string | null, oldValue: unknown, newValue: unknown, branchId: string) {
  run(`INSERT INTO audit_log (id, branch_id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [randomUUID(), branchId, entityType === 'stock_lots' ? 'Stock' : 'Product', entityType, entityId, action, field,
    oldValue === undefined || oldValue === null ? null : (typeof oldValue === 'string' ? oldValue : S(oldValue)),
    newValue === undefined || newValue === null ? null : (typeof newValue === 'string' ? newValue : S(newValue)), ACTOR, NOW]);
}
function track(table: string, id: string, action: 'insert' | 'update', branchId: string) {
  const row = one(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  run('INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [table, id, branchId, action, S(row ?? {}), NOW]);
}

// ── A: Altbestand VAN-BGJ-005/006 ────────────────────────────────────────────
const VAN = [
  { sku: 'VAN-BGJ-005', id: '25e7eea7-27cf-4260-a84f-3ee2910038f9', erp: 4, gezaehlt: 7, kaufLos: '788b90b2-4d2e-41c8-85c5-3efbc7f5a7e0', kaufLosKosten: 180, einstand: 190 as number | null },
  { sku: 'VAN-BGJ-006', id: '8619ba77-bbc5-4c6d-8951-3b7c848ba0a0', erp: 1, gezaehlt: 2, kaufLos: '73be20b8-48ea-474b-a4d9-e30b60d828a8', kaufLosKosten: 130, einstand: 140 as number | null },
];
const EINKAUF = 'baf1522a-2687-426b-a91b-9e82f3e76892';   // PUR-2026-000024
const altLosId = (productId: string) => `f1-oldstock-${productId}`;

type Plan = { art: string; sku: string; status: string; detail: string; tun?: () => void; ids?: string[] };
function planVan(v: (typeof VAN)[number]): Plan {
  const p = one('SELECT * FROM products WHERE id = ?', [v.id]);
  if (!p || p.sku !== v.sku) return { art: 'A', sku: v.sku, status: 'ABBRUCH', detail: 'Artikel nicht gefunden oder andere SKU' };
  const lose = q('SELECT * FROM stock_lots WHERE product_id = ? ORDER BY created_at', [v.id]);
  const delta = v.gezaehlt - v.erp;
  const vorhanden = lose.find((l) => l.id === altLosId(v.id));
  if (vorhanden) {
    const gleich = Number(vorhanden.qty_total) === delta && (v.einstand === null || Number(vorhanden.unit_cost) === v.einstand) && Number(p.quantity) === v.gezaehlt;
    return { art: 'A', sku: v.sku, status: gleich ? 'BEREITS_KORRIGIERT' : 'ABBRUCH', detail: gleich ? `Altlos ${delta} × ${vorhanden.unit_cost} da, Menge ${p.quantity}` : `Altlos weicht ab: ${S(vorhanden)} / Menge ${p.quantity}` };
  }
  if (v.einstand === null) return { art: 'A', sku: v.sku, status: 'ABBRUCH', detail: `Einstand des Altstücks fehlt (+${delta} Stück)` };
  const fehler: string[] = [];
  if (Number(p.quantity) !== v.erp) fehler.push(`Menge ${p.quantity} statt ${v.erp}`);
  if (String(p.source_type ?? 'OWN').toUpperCase() !== 'OWN') fehler.push('nicht eigene Ware');
  if (String(p.stock_status) !== 'in_stock') fehler.push(`Status ${p.stock_status}`);
  if (lose.length !== 1) fehler.push(`${lose.length} Lose statt 1`);
  const k = lose[0];
  if (k && (k.id !== v.kaufLos || k.purchase_id !== EINKAUF || Number(k.qty_total) !== v.erp || Number(k.qty_remaining) !== v.erp || k.status !== 'ACTIVE' || Number(k.unit_cost) !== v.kaufLosKosten)) fehler.push(`Einkaufslos weicht ab: ${S({ id: k.id, purchase: k.purchase_id, total: k.qty_total, rest: k.qty_remaining, status: k.status, kosten: k.unit_cost })}`);
  const verkauft = Number(one('SELECT COUNT(*) AS n FROM invoice_lines WHERE product_id = ?', [v.id])?.n);
  if (verkauft) fehler.push(`${verkauft} Rechnungszeilen`);
  const korr = Number(one('SELECT COUNT(*) AS n FROM stock_adjustments WHERE product_id = ?', [v.id])?.n);
  if (korr) fehler.push(`${korr} Bestandskorrekturen`);
  if (fehler.length) return { art: 'A', sku: v.sku, status: 'ABBRUCH', detail: fehler.join('; ') };
  const seit = String(p.purchase_date || String(p.created_at || '').slice(0, 10));
  const lotId = altLosId(v.id);
  const einstand = v.einstand as number;
  return {
    art: 'A', sku: v.sku, status: 'KORREKTUR', ids: [v.id, lotId],
    detail: `+${delta} Stück als Altlos (Einstand ${einstand} BHD, seit ${seit}), Menge ${v.erp} → ${v.gezaehlt}; Einkaufslos ${v.erp} × ${v.kaufLosKosten} unverändert`,
    tun: () => {
      const branchId = String(p.branch_id || 'branch-main');
      run(`INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, purchase_line_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'ACTIVE', ?, ?)`, [lotId, branchId, v.id, einstand, delta, delta, seit, NOW]);
      const u = run(`UPDATE products SET quantity = (SELECT SUM(qty_remaining) FROM stock_lots WHERE product_id = ? AND status != 'CANCELLED'), updated_at = ?
                     WHERE id = ? AND quantity = ?`, [v.id, NOW, v.id, v.erp]);
      if (Number(u.changes) !== 1) fail(`${v.sku}: Menge hat sich geändert`);
      const neu = Number(one('SELECT quantity FROM products WHERE id = ?', [v.id])?.quantity);
      if (neu !== v.gezaehlt) fail(`${v.sku}: Menge ${neu} statt ${v.gezaehlt}`);
      audit('stock_lots', lotId, 'CREATE', null, null, { productId: v.id, quantity: delta, unitCost: einstand, reason: 'OLD_STOCK_RESTORED_AFTER_F1',
        countedQuantity: v.gezaehlt, erpQuantityBefore: v.erp, purchaseLotKept: v.kaufLos, purchase: 'PUR-2026-000024', note: 'Owner count confirmed; data fix v0.8.97' }, branchId);
      audit('products', v.id, 'UPDATE', 'quantity', v.erp, { quantity: v.gezaehlt, oldStockLot: lotId, reason: 'OLD_STOCK_RESTORED_AFTER_F1' }, branchId);
      track('stock_lots', lotId, 'insert', branchId);
      track('products', v.id, 'update', branchId);
    },
  };
}

// ── B: Diamond Weight aus den Diamant-Zeilen ─────────────────────────────────
const kanon = (v: unknown): unknown => Array.isArray(v) ? v.map(kanon) : (v && typeof v === 'object')
  ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, kanon((v as Record<string, unknown>)[k])]))
  : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
function planGd(): Plan[] {
  const kat = q('SELECT id FROM categories').map((r) => String(r.id)).filter((id) => st.stonesApply(id));
  const plaene: Plan[] = [];
  for (const p of q(`SELECT * FROM products WHERE category_id IN (${kat.map(() => '?').join(',') || "''"}) ORDER BY sku`, kat)) {
    let a: Record<string, unknown>;
    try { a = JSON.parse(String(p.attributes || '{}')); } catch { plaene.push({ art: 'B', sku: String(p.sku), status: 'PRUEFBEDARF', detail: 'attributes nicht lesbar' }); continue; }
    const zeilen = Array.isArray(a.stones) ? a.stones as Array<Record<string, unknown>> : [];
    if (!zeilen.length) continue;
    const n = st.normalizeStoneAttributes(String(p.category_id), a);
    if (n.issues.length) { plaene.push({ art: 'B', sku: String(p.sku), status: 'PRUEFBEDARF', detail: 'Steinzeilen ungültig: ' + n.issues.map((i) => i.code).join(',') }); continue; }
    const ab = n.attributes.diamond_weight;
    const gesp = a.diamond_weight;
    if (ab === undefined) {
      if (zeilen.some((z) => z && z.type === 'diamond' && (z.carat === undefined || z.carat === null || z.carat === ''))) plaene.push({ art: 'B', sku: String(p.sku), status: 'PRUEFBEDARF', detail: 'Diamantzeile ohne Karat — Gewicht nicht bestimmbar' });
      continue;
    }
    if (gesp !== undefined && gesp !== null && gesp !== '') {
      if (Math.round(Number(gesp) * 1000) === Math.round(Number(ab) * 1000)) continue;   // schon richtig
      plaene.push({ art: 'B', sku: String(p.sku), status: 'PRUEFBEDARF', detail: `gespeichert ${gesp} ≠ aus Zeilen ${ab}` }); continue;
    }
    const sonst = (x: Record<string, unknown>) => S(kanon(Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'diamond_weight'))));
    if (sonst(n.attributes as Record<string, unknown>) !== sonst(a)) { plaene.push({ art: 'B', sku: String(p.sku), status: 'PRUEFBEDARF', detail: 'Normalisierung ändert mehr als das Gewicht' }); continue; }
    const vorher = String(p.attributes);
    const nachher = S({ ...a, diamond_weight: Number(ab) });
    plaene.push({
      art: 'B', sku: String(p.sku), status: 'KORREKTUR', ids: [String(p.id)], detail: `Diamond Weight ${ab} ct (aus ${zeilen.filter((z) => z.type === 'diamond').length} Diamant-Zeile(n))`,
      tun: () => {
        const u = run('UPDATE products SET attributes = ? WHERE id = ? AND attributes = ?', [nachher, p.id, vorher]);
        if (Number(u.changes) !== 1) fail(`${p.sku}: Merkmale haben sich geändert`);
        const branchId = String(p.branch_id || 'branch-main');
        audit('products', String(p.id), 'UPDATE', 'diamond_weight', null, { diamond_weight: Number(ab), reason: 'DIAMOND_WEIGHT_FROM_STONE_ROWS', note: 'data fix v0.8.97' }, branchId);
        track('products', String(p.id), 'update', branchId);
      },
    });
  }
  return plaene;
}

// ── Ablauf ───────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  const integ = one('PRAGMA integrity_check')?.integrity_check;
  if (integ !== 'ok') fail(`integrity_check vorher: ${integ}`);
  const plaene = [...(ONLY === 'B' ? [] : VAN.map(planVan)), ...(ONLY === 'A' ? [] : planGd())];
  const zaehl = (art: string, status: string) => plaene.filter((p) => p.art === art && p.status === status).length;
  for (const p of plaene.filter((x) => x.art === 'A')) console.log(`A ${p.sku}: ${p.status} — ${p.detail}`);
  console.log(`B Gold-Diamond: KORREKTUR ${zaehl('B', 'KORREKTUR')}, PRUEFBEDARF ${zaehl('B', 'PRUEFBEDARF')}`);
  for (const p of plaene.filter((x) => x.art === 'B' && x.status === 'PRUEFBEDARF')) console.log(`   Prüfbedarf ${p.sku}: ${p.detail}`);
  if (plaene.some((p) => p.status === 'ABBRUCH')) fail('Vorbedingung nicht erfüllt — nichts geändert');
  const tun = plaene.filter((p) => p.status === 'KORREKTUR');
  if (!APPLY) { console.log(`PLAN: ${tun.length} Korrekturen (ohne --apply nichts geschrieben)`); }
  else if (tun.length === 0) { console.log('NICHTS ZU TUN: alles bereits korrigiert (idempotent)'); }
  else {
    const vorFp = fingerprint(), vorP = productRows(), vorL = lotRows();
    const vorAudit = Number(one('SELECT COUNT(*) AS n FROM audit_log')?.n), vorLog = Number(one('SELECT COUNT(*) AS n FROM sync_changelog')?.n);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of tun) p.tun!();
      // Nachher: nur die erwarteten Zeilen, nur die erwarteten Spalten
      const nachFp = fingerprint();
      if (S(nachFp) !== S(vorFp)) fail(`geschützte Tabellen verändert: ${S(vorFp)} → ${S(nachFp)}`);
      const erwartetP = new Set(tun.flatMap((p) => p.ids || []));
      const nachP = productRows();
      for (const [id, r] of nachP) {
        const o = vorP.get(id); if (!o) fail(`neuer Artikel ${id}`);
        const diff = Object.keys(r).filter((k) => String(r[k]) !== String(o![k]));
        if (!diff.length) continue;
        if (!erwartetP.has(id)) fail(`unerwartet geändert: Artikel ${r.sku} (${diff.join(',')})`);
        const vanFix = VAN.some((v) => v.id === id);
        const erlaubt = vanFix ? ['quantity', 'updated_at'] : ['attributes'];
        if (diff.some((k) => !erlaubt.includes(k))) fail(`${r.sku}: unerwartete Spalten ${diff.join(',')}`);
        if (!vanFix) {
          const a = JSON.parse(String(o!.attributes)), b = JSON.parse(String(r.attributes));
          const ohne = (x: Record<string, unknown>) => S(Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'diamond_weight')));
          if (ohne(a) !== ohne(b) || a.diamond_weight !== undefined) fail(`${r.sku}: Merkmale außer Diamond Weight verändert`);
        }
      }
      const nachL = lotRows();
      for (const [id, l] of vorL) if (S(nachL.get(id)) !== S(l)) fail(`bestehendes Los verändert: ${id}`);
      const neueLose = [...nachL.keys()].filter((id) => !vorL.has(id));
      const erwarteteLose = tun.filter((p) => p.art === 'A').map((p) => p.ids![1]);
      if (S(neueLose.sort()) !== S([...erwarteteLose].sort())) fail(`neue Lose ${S(neueLose)} statt ${S(erwarteteLose)}`);
      for (const v of VAN) {
        if (!erwarteteLose.includes(altLosId(v.id))) continue;
        const summe = Number(one("SELECT SUM(qty_remaining) AS s FROM stock_lots WHERE product_id = ? AND status != 'CANCELLED'", [v.id])?.s);
        const menge = Number(one('SELECT quantity FROM products WHERE id = ?', [v.id])?.quantity);
        if (summe !== v.gezaehlt || menge !== v.gezaehlt) fail(`${v.sku}: Σ Lose ${summe}, Menge ${menge}, gezählt ${v.gezaehlt}`);
      }
      const dAudit = Number(one('SELECT COUNT(*) AS n FROM audit_log')?.n) - vorAudit, dLog = Number(one('SELECT COUNT(*) AS n FROM sync_changelog')?.n) - vorLog;
      const nA = tun.filter((p) => p.art === 'A').length, nB = tun.filter((p) => p.art === 'B').length;
      if (dAudit !== nA * 2 + nB || dLog !== nA * 2 + nB) fail(`Protokoll ${dAudit}/${dLog} statt ${nA * 2 + nB}`);
      const integ2 = one('PRAGMA integrity_check')?.integrity_check;
      if (integ2 !== 'ok') fail(`integrity_check nachher: ${integ2}`);
      db.exec('COMMIT');
      console.log(`ANGEWENDET: ${nA} Altbestand-Korrektur(en), ${nB} Diamond-Weight-Nachträge; Hauptbuch, Einkäufe, Rechnungen, Zahlungen, Korrekturen unverändert; Protokoll +${dAudit}, Änderungsliste +${dLog}; integrity ok`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* schon zu */ }
      throw e;
    }
  }
} catch (e) {
  console.error('ABBRUCH:', e instanceof Abbruch ? e.message : e);
  exitCode = 1;
} finally {
  db.close();
}
process.exit(exitCode);
