// ════════════════════════════════════════════════════════════════════════════
// F10 — Gold-Schmuck „New" wiederherstellen, den die alte Start-Umstellung still auf „Pre-Owned" gesetzt hat.
//
// Nur mit Beweis aus der eigenen Datenbank, nie pauschal: Jede geschäftliche Änderung eines Artikels steht als
// VOLLE Zeile im Änderungsprotokoll (`sync_changelog`, `trackChange` liest die echte Zeile). Die Start-Umstellung
// schrieb dort nichts. Ein Artikel gilt als still umgestellt, wenn sein letzter protokollierter Stand „New" zeigt,
// heute „Pre-Owned" dasteht und sich sonst NICHTS geändert hat (gleiches `updated_at`, gleiche Spalten außer den
// abgeleiteten). Fehlt das Protokoll oder weicht etwas ab, ist es kein Beweis — der Artikel bleibt, wie er ist.
//
// Ausgelöst nur ausdrücklich vom Owner (Admin), am Primary, in EINER Transaktion: Zustand, Sync-Eintrag und
// strenges Protokoll zusammen oder gar nicht. Menge, Preise, Bewertung und Buchungen bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackChange, watchSyncTracks } from '@/core/sync/sync-service';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { canonicalRole } from '@/core/models/types';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { useAuthStore } from '@/stores/authStore';
import { GOLD_CONDITION_FLAG } from '@/core/db/legacy-gold-condition';

export class GoldConditionRestoreRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'GoldConditionRestoreRejected';
  }
}

const GOLD = 'cat-gold-jewelry';
/** Abgeleitete Spalten, die die App ohne Protokoll nachrechnet — kein Teil des Beweises. */
const ABGELEITET = new Set(['condition', 'days_in_stock', 'image_hash', 'image_description', 'image_embedding']);

export interface GoldConditionEvidence {
  productId: string;
  name: string;
  sku: string;
  /** Der protokollierte Stand mit „New" (Zeile im Änderungsprotokoll). */
  changeId: number;
  trackedAt: string;
}

const gleich = (a: unknown, b: unknown): boolean => String(a ?? '') === String(b ?? '');

/** Rein lesend: der Beweis für einen Artikel — oder der Grund, warum es keiner ist. */
export function goldConditionEvidence(productId: string): { evidence: GoldConditionEvidence | null; issue: string | null } {
  const nein = (issue: string) => ({ evidence: null, issue });
  const row = query('SELECT * FROM products WHERE id = ?', [productId])[0];
  if (!row) return nein('no such item');
  if (row.category_id !== GOLD) return nein('not a Gold-Diamond Jewellery item');
  if (row.condition !== 'Pre-Owned') return nein(`its condition is "${String(row.condition ?? '')}", not "Pre-Owned"`);
  const opts = String(query('SELECT condition_options FROM categories WHERE id = ?', [GOLD])[0]?.condition_options ?? '');
  if (!opts.includes('"New"')) return nein('the category does not offer "New"');
  const last = query(
    "SELECT id, action, data, created_at FROM sync_changelog WHERE table_name = 'products' AND record_id = ? ORDER BY id DESC LIMIT 1",
    [productId],
  )[0];
  if (!last) return nein('no recorded change of this item');
  if (last.action === 'delete') return nein('its last recorded change is a delete');
  let d: Record<string, unknown>;
  try { d = JSON.parse(String(last.data)) as Record<string, unknown>; } catch { return nein('its last recorded change cannot be read'); }
  if (d.condition !== 'New') return nein(`its last recorded condition is "${String(d.condition ?? '')}", not "New"`);
  if (!gleich(d.updated_at, row.updated_at)) return nein('the item was changed after its last recorded change');
  for (const [k, v] of Object.entries(d)) {
    if (ABGELEITET.has(k) || !(k in row)) continue;
    if (!gleich(v, row[k])) return nein(`"${k}" differs from its last recorded change`);
  }
  return {
    evidence: { productId, name: String(row.name ?? ''), sku: String(row.sku ?? ''), changeId: Number(last.id), trackedAt: String(last.created_at ?? '') },
    issue: null,
  };
}

/** Rein lesend: alle Gold-Schmuck-Artikel mit Beweis (für die Anzeige „Data Repairs"). */
export function goldConditionRestoreCandidates(): GoldConditionEvidence[] {
  return query("SELECT id FROM products WHERE category_id = ? AND condition = 'Pre-Owned' ORDER BY created_at", [GOLD])
    .map((r) => goldConditionEvidence(String(r.id)).evidence)
    .filter((e): e is GoldConditionEvidence => e !== null);
}

export interface GoldConditionRestoreInput { productIds: string[]; reason: string }
export interface GoldConditionRestored { restored: Array<{ productId: string; changeId: number }> }
export interface RepairCtx { branchId: string; userId: string; now: string; role?: string }

/** In der Transaktion des Aufrufers: ALLE genannten Artikel mit Beweis auf „New" — oder keiner. */
export function restoreGoldConditionInHouse(input: GoldConditionRestoreInput, ctx: RepairCtx): GoldConditionRestored {
  if (canonicalRole(ctx.role) !== 'ADMIN') throw new GoldConditionRestoreRejected('PERMISSION_DENIED', 'only the owner (admin) may restore item conditions');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new GoldConditionRestoreRejected('REASON_REQUIRED', 'please enter a reason');
  const ids = Array.isArray(input.productIds) ? [...new Set(input.productIds.filter((x) => typeof x === 'string' && x))] : [];
  if (ids.length === 0) throw new GoldConditionRestoreRejected('NOTHING_TO_RESTORE', 'no item named — nothing was changed');
  if (query('SELECT value FROM settings WHERE key = ?', [GOLD_CONDITION_FLAG])[0]?.value !== '1') {
    throw new GoldConditionRestoreRejected('STARTUP_FIX_NOT_ACTIVE', 'the start-up fix is not active in this database yet — restart the app first; nothing was changed');
  }
  const beweise = ids.map((id) => ({ id, ...goldConditionEvidence(id) }));
  const ohne = beweise.filter((b) => b.issue !== null);
  if (ohne.length > 0) {
    throw new GoldConditionRestoreRejected('GOLD_RESTORE_NOT_PROVEN',
      `${ohne.map((b) => `${b.id}: ${b.issue}`).join('; ')} — nothing was changed`);
  }
  const abgleich = watchSyncTracks('restore gold condition');
  const db = getDatabase();
  const restored: GoldConditionRestored['restored'] = [];
  for (const b of beweise) {
    db.run(`UPDATE products SET condition = 'New', updated_at = ? WHERE id = ? AND category_id = ? AND condition = 'Pre-Owned'`,
      [ctx.now, b.id, GOLD]);
    if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw new GoldConditionRestoreRejected('GOLD_RESTORE_NOT_PROVEN', `${b.id} changed meanwhile — nothing was changed`);
    trackChange('products', b.id, 'update', {});
    logAuditOrThrow({
      module: 'Product', entityType: 'products', entityId: b.id, action: 'UPDATE', field: 'condition',
      oldValue: 'Pre-Owned',
      newValue: { condition: 'New', repair: 'F10_GOLD_CONDITION_RESTORE', evidenceChangeId: b.evidence!.changeId, reason },
      actor: { userId: ctx.userId, branchId: ctx.branchId },
    });
    restored.push({ productId: b.id, changeId: b.evidence!.changeId });
  }
  abgleich();
  return { restored };
}

function localCtx(): RepairCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}

/** Am Primary — exklusiv, EINE Transaktion, erst danach durabel. Auf PC2 nicht. */
export function restoreGoldConditionOnPrimary(input: GoldConditionRestoreInput, reload: () => void): Promise<GoldConditionRestored> {
  if (isClientMode()) {
    return Promise.reject(new GoldConditionRestoreRejected('PRIMARY_ONLY', 'this repair runs on the main computer only'));
  }
  return runOnPrimary(() => restoreGoldConditionInHouse(input, localCtx()), reload);
}
