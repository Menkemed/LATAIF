// ═════════════════════════════════════════════════════════════════
// PRODUCT-LEFTOVERS — was beim Löschen eines Artikels mit weg muss: sein Upload-Beleg vom Telefon und seine Fotos.
//
// Vorher löschte jeder Weg nur die Zeile in `products`. Stehen blieben:
//   • der Beleg (`mobile_upload_receipts`), und
//   • die AKTIVEN Foto-Verknüpfungen (`media_links`). Die Medien-Erreichbarkeit (Rust `reachability`, REQUIRED) fragt
//     nur „aktive Verknüpfung → Medium → aktuelle Datei“ und nicht, ob der Artikel noch existiert — die Fotos eines
//     gelöschten Artikels galten also weiter als gebraucht und gingen in jede Sicherung mit.
//
// Jetzt: der Beleg wird gelöscht, die Verknüpfungen werden entfernt markiert (`deleted_at`) — genau wie beim Entfernen
// eines Fotos aus der Galerie (`media-links.ts`). Medium, Varianten, Blob und Generationen bleiben unberührt: Generationen
// dürfen per Schema nicht hart gelöscht werden (`trg_mbg_no_delete`), und die Medien-Aufräumung bewahrt jede Datei, auf
// die noch eine Generation zeigt (PRESERVED). Die Datei bleibt also liegen; sie gehört nur zu nichts mehr.
//
// Der Beleg ist der Wiederaufsetzpunkt eines Telefon-Uploads, der noch nicht `ready` ist. Fehlt er, würde so ein
// Auftrag den Artikel neu anlegen — deshalb weist der Drain jeden Auftrag ab, dessen Artikel gelöscht wurde
// (`productWasDeleted`). Gelöscht heißt: das Löschen steht im Abgleich- oder im Änderungsprotokoll.
// ═════════════════════════════════════════════════════════════════

/** Der Datenbankzugang (sql.js `Database` oder dieselbe Form im Test). */
export interface LeftoverDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface LeftoverResult {
  /** gelöschte Upload-Belege */
  receipts: number;
  /** entfernt markierte Foto-Verknüpfungen */
  links: number;
}

function values(db: LeftoverDb, sql: string, params: unknown[] = []): unknown[][] {
  const r = db.exec(sql, params);
  return r.length ? r[0].values : [];
}
function hasTable(db: LeftoverDb, name: string): boolean {
  return values(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]).length > 0;
}
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

/**
 * Entfernt Beleg und Foto-Verknüpfungen der GELÖSCHTEN Artikel `productIds`. Läuft im Schreibschritt des Aufrufers
 * (keine eigene Transaktion, kein Speichern). Fehlt eine Tabelle (Teildatenbank im Test), wird ihr Teil übersprungen.
 */
export function purgeProductLeftovers(db: LeftoverDb, productIds: readonly string[], now = new Date().toISOString()): LeftoverResult {
  const ids = [...new Set(productIds.filter((id) => typeof id === 'string' && id !== ''))];
  const res: LeftoverResult = { receipts: 0, links: 0 };
  if (ids.length === 0) return res;
  const ph = marks(ids.length);

  if (hasTable(db, 'mobile_upload_receipts')) {
    res.receipts = Number(values(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE product_id IN (${ph})`, ids)[0][0]);
    if (res.receipts) db.run(`DELETE FROM mobile_upload_receipts WHERE product_id IN (${ph})`, ids);
  }
  if (hasTable(db, 'media_links')) {
    const active = `entity_type = 'product' AND entity_id IN (${ph}) AND deleted_at IS NULL`;
    res.links = Number(values(db, `SELECT COUNT(*) FROM media_links WHERE ${active}`, ids)[0][0]);
    if (res.links) db.run(`UPDATE media_links SET deleted_at = ?, is_primary = 0 WHERE ${active}`, [now, ...ids]);
  }
  return res;
}

/** Wurde dieser Artikel gelöscht? Belegt durch das Löschen im Abgleich- oder im Änderungsprotokoll. */
export function productWasDeleted(db: LeftoverDb, productId: string): boolean {
  if (!productId) return false;
  return (hasTable(db, 'sync_changelog')
      && values(db, `SELECT 1 FROM sync_changelog WHERE table_name = 'products' AND record_id = ? AND action = 'delete' LIMIT 1`, [productId]).length > 0)
    || (hasTable(db, 'audit_log')
      && values(db, `SELECT 1 FROM audit_log WHERE entity_type = 'products' AND entity_id = ? AND action_type = 'DELETE' LIMIT 1`, [productId]).length > 0);
}

/**
 * Beim Start: Reste von Artikeln, die schon gelöscht sind (auch von vor diesem Stand). Nur Artikel, die es nicht mehr
 * gibt UND deren Löschen protokolliert ist — ein halb angelegter Artikel ohne Löschung bleibt unberührt.
 */
export function sweepDeletedProductLeftovers(db: LeftoverDb, now = new Date().toISOString()): LeftoverResult & { products: number } {
  const candidates = new Set<string>();
  if (hasTable(db, 'media_links')) {
    for (const [id] of values(db, `SELECT DISTINCT l.entity_id FROM media_links l
                                    WHERE l.entity_type = 'product' AND l.deleted_at IS NULL
                                      AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = l.entity_id)`)) candidates.add(String(id));
  }
  if (hasTable(db, 'mobile_upload_receipts')) {
    for (const [id] of values(db, `SELECT DISTINCT r.product_id FROM mobile_upload_receipts r
                                    WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = r.product_id)`)) candidates.add(String(id));
  }
  const ids = [...candidates].filter((id) => productWasDeleted(db, id));
  return { products: ids.length, ...purgeProductLeftovers(db, ids, now) };
}

/**
 * `purgeProductLeftovers` in einem Sicherungspunkt: gelingt es nicht, bleibt alles wie vorher (die Reste blieben dann
 * stehen und der nächste Start räumt sie). Das Löschen des Artikels selbst hängt nie daran.
 */
export function purgeProductLeftoversSafely(db: LeftoverDb, productIds: readonly string[]): LeftoverResult | null {
  try {
    db.run('SAVEPOINT product_leftovers');
  } catch (err) {
    console.warn('[Delete] leftovers not cleaned (no savepoint):', err);
    return null;
  }
  try {
    const r = purgeProductLeftovers(db, productIds);
    db.run('RELEASE product_leftovers');
    return r;
  } catch (err) {
    try { db.run('ROLLBACK TO product_leftovers'); db.run('RELEASE product_leftovers'); } catch { /* nothing more to undo */ }
    console.warn('[Delete] leftovers not cleaned:', err);
    return null;
  }
}
