// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5B — was jede Anlage vom zweiten Rechner braucht, an EINEM Ort.
//
// Die Zwischenablage (`/api/staging/media`) kannte bisher nur `products.create`. Eine Kommission
// legt denselben Artikel an und bringt dieselben Bilder mit — sie darf dafür keinen zweiten Weg
// bekommen. Also wohnen die Bausteine hier und beide Befehle benutzen sie:
//
//   • eine Bildkennung ist ein Inhaltshash, sonst nichts (kein Pfad, kein Name, keine URL);
//   • die Bytes holt der Primary INNERHALB des Auftrags, als Eigentümer die GEPRÜFTE Identität;
//   • nach einem Erfolg wird die Ablage geräumt — schlägt das fehl, räumt der Start auf.
//
// Und eine Regel, die für jede Anlage gilt: die Filiale des Auftrags muss die sein, deren Bücher
// dieser Rechner führt. Die Domäne schreibt in die Filiale der Sitzung; ein Ausweis einer anderen
// Filiale darf dort nichts anlegen.
// ════════════════════════════════════════════════════════════════════════════
import { currentBranchId } from '@/core/db/helpers';
import { CommandRejected } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';

/** Höchstens so viele Bilder pro Anlage — dieselbe Zahl wie am mobilen Eingang. */
export const MAX_REMOTE_IMAGES = 8;

/** Eine Kennung der Zwischenablage ist der SHA-256 ihres Inhalts: 64 Hex-Zeichen, sonst nichts. */
export function isStagingId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/**
 * Wem eine Ablage gehört. Die drei Angaben kommen aus der GEPRÜFTEN Identität des Auftrags — nie
 * aus seiner Nutzlast. Eine Ablage eines anderen Mandanten, einer anderen Filiale oder eines
 * anderen Benutzers ist von hier aus schlicht nicht vorhanden.
 */
export interface StagingOwner {
  tenantId: string;
  branchId: string;
  userId: string;
}

/** Wie der Primary an die abgelegten Bytes kommt. Injizierbar, damit ein Test ohne Tauri läuft. */
export type StagedMediaReader = (stagingId: string, owner: StagingOwner) => Promise<{ mime: string; dataBase64: string }>;
export type StagedMediaDiscard = (stagingId: string, owner: StagingOwner) => Promise<void>;

export async function invokeReadStaged(stagingId: string, owner: StagingOwner): Promise<{ mime: string; dataBase64: string }> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('staging_media_read', { stagingId, ...owner });
}

export async function invokeDiscardStaged(stagingId: string, owner: StagingOwner): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('staging_media_discard', { stagingId, ...owner });
}

export function stagingOwnerOf(identity: CommandIdentity): StagingOwner {
  return { tenantId: identity.tenantId, branchId: identity.branchId, userId: identity.userId };
}

/** Die Liste der Kennungen prüfen — BEVOR daraus irgendwo ein Dateizugriff wird. */
export function parseStagingIds(raw: unknown, fail: (message: string) => Error): string[] {
  const ids = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(ids)) throw fail('stagingIds must be a list');
  if (ids.length > MAX_REMOTE_IMAGES) throw fail(`at most ${MAX_REMOTE_IMAGES} images`);
  for (const id of ids) {
    if (!isStagingId(id)) throw fail('a staged image is named by its content hash');
  }
  if (new Set(ids as string[]).size !== ids.length) throw fail('the same staged image twice is not an order');
  return ids as string[];
}

/**
 * Die Bytes holen — INNERHALB des Auftrags. Eine Wiederholung mit derselben Kennung führt den
 * Handler nicht mehr aus; läge das Lesen davor, scheiterte genau die Wiederholung, für die es die
 * Kennung gibt (die Ablage ist nach dem ersten Erfolg geräumt).
 */
export async function readStagedAsDataUrls(
  ids: readonly string[], owner: StagingOwner, read: StagedMediaReader, fail: (message: string) => Error,
): Promise<string[]> {
  const images: string[] = [];
  for (const id of ids) {
    let blob: { mime: string; dataBase64: string };
    try {
      blob = await read(id, owner);
    } catch (e) {
      // Kein Urteil der Domäne: nichts wird festgehalten, die Transaktion geht zurück. Dieselben
      // Bytes bekommen beim erneuten Ablegen dieselbe Kennung.
      throw fail(`staged image is gone: ${id} (${String(e)})`);
    }
    images.push(`data:${blob.mime};base64,${blob.dataBase64}`);
  }
  return images;
}

/** Nach dem Erfolg: die Ablage hat ihren Zweck verloren. Ein Fehler hier ist keiner des Auftrags. */
export async function discardStagedAfterSuccess(
  ids: readonly string[], owner: StagingOwner, discard: StagedMediaDiscard,
): Promise<void> {
  for (const id of ids) {
    try { await discard(id, owner); } catch { /* der Start räumt auf */ }
  }
}

/**
 * Die Filiale des Auftrags ist die, deren Bücher dieser Rechner führt. Die Domäne legt in der
 * Filiale der Sitzung an — ein Ausweis einer anderen Filiale bekommt ein Nein, statt still in
 * fremde Bücher zu schreiben.
 */
export function assertHouseBranch(identity: CommandIdentity): void {
  let house = '';
  try { house = currentBranchId(); } catch { house = ''; }
  if (!house || house !== identity.branchId) {
    throw new CommandRejected('BRANCH_MISMATCH', 'this computer does not keep the books of that branch');
  }
}
