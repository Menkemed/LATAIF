// ════════════════════════════════════════════════════════════════════════════
// F10 — die historische Umstellung „Gold-Schmuck New → Pre-Owned" GENAU EINMAL je Datenbank.
//
// Am 2026-05-17 verlor „Gold-Diamond Jewellery" den Zustand „New"; die damals vorhandenen Artikel mit „New" wurden
// auf „Pre-Owned" umgestellt. Seit v0.6.7 (2026-05-23) ist „New" dort wieder erlaubt (frisch geschmiedete Stücke,
// Neueinkäufe) — die Umstellung stand aber im Migrationsblock, der bei JEDEM Start läuft, und überschrieb so bei
// jedem Start einen vom Benutzer gesetzten Zustand „New" still mit „Pre-Owned".
//
// Jetzt:
//   • Merker gesetzt → nichts.
//   • Erlaubte die Kategorie „New" schon VOR diesem Start, lief die Datenbank mit v0.6.7 oder später: die
//     historische Umstellung ist dort längst geschehen, jedes „New" seitdem ist eine gültige Eingabe → nur der Merker.
//   • Gibt es die Kategorie noch nicht (neue Datenbank), gibt es nichts umzustellen → nur der Merker.
//   • Nur eine Datenbank aus der Zeit, in der „New" nicht erlaubt war, wird einmal umgestellt — zusammen mit dem
//     Merker in einem Sicherungspunkt, ganz oder gar nicht.
//
// Die schon still umgestellten Artikel werden hier NICHT zurückgesetzt — dafür gibt es die belegte, ausdrücklich
// ausgelöste Wiederherstellung (`core/products/gold-condition-restore.ts`).
// ════════════════════════════════════════════════════════════════════════════
import type { LegacyRepairDb } from './legacy-stock-repair';

export const GOLD_CONDITION_FLAG = 'migration.gold_condition_pre_owned_once_v1';

/** Die historische Umstellung, im alten Wortlaut. */
export const GOLD_NEW_TO_PRE_OWNED =
  `UPDATE products SET condition = 'Pre-Owned' WHERE category_id = 'cat-gold-jewelry' AND condition = 'New'`;

/**
 * VOR dem Migrationsblock zu fragen (der Block setzt die Liste kurz ohne und dann wieder mit „New"):
 * `true` = die Kategorie erlaubte „New" schon, `false` = sie gibt es ohne „New", `null` = es gibt sie nicht.
 */
export function goldCategoryAllowedNew(db: LegacyRepairDb): boolean | null {
  try {
    const row = db.exec("SELECT condition_options FROM categories WHERE id = 'cat-gold-jewelry'")[0]?.values?.[0];
    if (!row) return null;
    return String(row[0] ?? '').includes('"New"');
  } catch {
    return null;   // noch keine Tabelle → neue Datenbank
  }
}

export type GoldConditionOutcome = 'already-done' | 'marked-applied' | 'applied' | 'failed';

/** Nach dem Migrationsblock zu rufen. `allowedNewBefore` ist die Antwort von `goldCategoryAllowedNew`, VOR dem Block gefragt. */
export function runGoldConditionMigrationOnce(db: LegacyRepairDb, allowedNewBefore: boolean | null): GoldConditionOutcome {
  const merker = db.exec('SELECT value FROM settings WHERE key = ?', [GOLD_CONDITION_FLAG])[0]?.values?.[0]?.[0];
  if (merker === '1') return 'already-done';
  const umstellen = allowedNewBefore === false;
  db.run('SAVEPOINT legacy_gold_condition');
  try {
    if (umstellen) db.run(GOLD_NEW_TO_PRE_OWNED);
    db.run(
      `INSERT INTO settings (branch_id, key, value, category, updated_at)
       VALUES ('branch-main', ?, '1', 'migration', ?)
       ON CONFLICT(branch_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [GOLD_CONDITION_FLAG, new Date().toISOString()],
    );
    db.run('RELEASE SAVEPOINT legacy_gold_condition');
    return umstellen ? 'applied' : 'marked-applied';
  } catch (err) {
    try { db.run('ROLLBACK TO SAVEPOINT legacy_gold_condition'); db.run('RELEASE SAVEPOINT legacy_gold_condition'); } catch { /* */ }
    console.warn('[Migration] gold condition migration skipped:', err);
    return 'failed';
  }
}
