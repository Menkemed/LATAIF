// CENTRAL-C3C — ein Produkt von einem zweiten Rechner anlegen und ändern.
//
// Das ist der schwierigste der drei Fernaufträge, und zwar wegen der Bilder. Eine Rechnung und ein
// Kunde sind Text; ein Produkt bringt Bytes mit, und Bytes gehören nicht in eine Auftragsnutzlast:
// die Warteschlange des Renderers ist für Nachrichten gebaut, nicht für 25-MiB-Stapel.
//
// Deshalb zwei getrennte Schritte, und der erste entscheidet nichts:
//
//   1. Der Client legt seine Bilder über `/api/staging/media` ab. Diese Stelle nimmt Bytes und gibt
//      eine Kennung zurück — den SHA-256 des Inhalts, vom Server berechnet. Sie schreibt keine
//      Zeile in die Geschäftsdatenbank, sie kennt kein Produkt, und es gibt kein Feld, in dem ein
//      Aufrufer einen Zielpfad nennen könnte.
//   2. Der Auftrag `products.create` nennt diese Kennungen. Der Primary holt die Bytes selbst und
//      fährt damit GENAU den Weg, den ein Mensch an diesem Rechner fährt: `createProductWithMedia`.
//
// Ausdrücklich NICHT benutzt wird `/api/mobile/upload`. Sie nimmt zwar auch Bilder an, ist aber
// ein PRODUKT-EINGANG: sie prüft Produktfelder, schreibt in `mobile_upload_inbox`, und ihr
// Abarbeiter legt das Produkt an. Ein Client, der sie benutzte, hätte einen zweiten Weg, auf dem
// ein Produkt entsteht — an dieser Maschine vorbei, ohne durablen Nachweis.
//
// Drei Entscheidungen, die den Client bewusst entmachten:
//
//  • **Die SKU vergibt der Primary.** Es gibt kein `sku`-Feld im Rumpf. Sie kommt aus demselben
//    durablen Zähler, aus dem sie auch lokal und für das Handy kommt (`allocateSkuOnCreate`);
//    zwei Rechner, die gleichzeitig anlegen, bekommen deshalb zwei Nummern und nicht dieselbe.
//  • **Ein unvollständiger Medienweg ist KEIN Erfolg.** Bleibt auch nur ein Bild aus, wird der
//    ganze Auftrag zurückgenommen: kein halbes Produkt, kein eingefrorenes „ok". Dieselbe Kennung
//    darf danach wiederholt werden, weil nichts durabel geworden ist.
//  • **Die Preissperre gilt auch von außen.** Ein Änderungsauftrag läuft mit
//    `priceEligibilityRequired: true` — dieselbe Prüfung in derselben Transaktion wie beim Handy.
//    Ein Artikel, der an einem Geschäftsvorgang hängt, ändert seinen Preis nicht, weil die Anfrage
//    von einem anderen Rechner kam.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { useProductStore } from '@/stores/productStore';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';

export const OP_PRODUCTS_CREATE = 'products.create';
export const OP_PRODUCTS_UPDATE = 'products.update';

/** Höchstens so viele Bilder pro Anlage — dieselbe Zahl wie am mobilen Eingang. */
export const MAX_REMOTE_IMAGES = 8;

/**
 * Was ein Mensch im Anlageformular eingibt. `sku` fehlt mit Absicht: sie ist keine Eingabe,
 * sondern eine Vergabe. `images` fehlt ebenfalls — Bilder kommen als Kennungen der Zwischenablage,
 * nie als Daten-URL im Auftrag.
 */
const CREATE_FIELDS = new Set([
  'categoryId', 'brand', 'name', 'quantity', 'condition', 'scopeOfDelivery',
  'storageLocation', 'purchaseDate', 'purchasePrice', 'purchaseCurrency',
  'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
  'stockStatus', 'taxScheme', 'supplierName', 'purchaseSource', 'paidFrom',
  'sourceType', 'notes', 'attributes',
]);

/**
 * Was ein Änderungsauftrag anfassen darf. Enger als das Anlegen, und aus denselben Gründen, aus
 * denen der mobile Edit enger ist: eine geänderte Kategorie zieht jedes Attribut auf eine andere
 * Definition um, und die Menge ist keine Texteigenschaft, sondern eine Bestandsaussage.
 */
const UPDATE_FIELDS = new Set([
  'brand', 'name', 'condition', 'scopeOfDelivery', 'storageLocation',
  'purchaseDate', 'purchasePrice', 'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
  'stockStatus', 'taxScheme', 'supplierName', 'purchaseSource', 'paidFrom',
  'sourceType', 'notes', 'attributes',
]);

/**
 * Felder, die der Client NIE setzen darf — jedes einzelne wäre eine andere Art, das Haus zu
 * belügen. `sku` steht hier ausdrücklich dabei: sie ist der Punkt, an dem zwei Rechner sich sonst
 * dieselbe Nummer geben.
 */
const FORBIDDEN = [
  'id', 'sku', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt',
  'expectedMargin', 'daysInStock', 'images', 'imageHash', 'imageDescription', 'imageEmbedding',
  'aiCorrections',
];

/**
 * Nicht „gehoert dem Primary", sondern „steht fest": eine Kategorie umzuhaengen zieht jedes
 * Attribut auf eine andere Definition um, und die Menge ist eine Bestandsaussage, kein Textfeld.
 * Beide bekommen ihre EIGENE Begruendung — „das darf nicht geaendert werden" ist etwas anderes als
 * „dieses Feld kenne ich nicht". Dieselbe Unterscheidung trifft der mobile Edit.
 */
const IMMUTABLE_ON_UPDATE: Record<string, string> = {
  categoryId: 'the category cannot be changed — it would re-base every attribute',
  quantity: 'quantity is a stock statement, not a product field',
};

export class ProductPayloadError extends Error {
  readonly code = 'PRODUCT_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ProductPayloadError';
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const NUMERIC = new Set([
  'quantity', 'purchasePrice', 'plannedSalePrice', 'minSalePrice', 'maxSalePrice',
]);

function value(k: string, v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (NUMERIC.has(k)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ProductPayloadError(`${k} must be a number`);
    if (v < 0) throw new ProductPayloadError(`${k} cannot be negative`);
    return v;
  }
  if (k === 'scopeOfDelivery') {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new ProductPayloadError('scopeOfDelivery must be a list of words');
    }
    return v;
  }
  if (k === 'attributes') {
    if (!isPlain(v)) throw new ProductPayloadError('attributes must be an object');
    return v;
  }
  if (typeof v !== 'string') throw new ProductPayloadError(`${k} must be text`);
  return v;
}

function fields(raw: Record<string, unknown>, allowed: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN.includes(k)) throw new ProductPayloadError(`the primary decides ${k}, not the client`);
    if (!allowed.has(k)) throw new ProductPayloadError(`unknown field: ${k}`);
    out[k] = value(k, v);
  }
  return out;
}

/** Eine Kennung der Zwischenablage ist der SHA-256 ihres Inhalts: 64 Hex-Zeichen, sonst nichts. */
export function isStagingId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

export interface ProductCreateRequest {
  categoryId: string;
  data: Record<string, unknown>;
  stagingIds: string[];
}

/**
 * Anlegen: eine Kategorie, ein Name, und eine Liste von Bildkennungen. Die Kategorie steht
 * SEPARAT und nicht in den Feldern — sie ist beim Anlegen erlaubt und beim Ändern verboten, und
 * zwei Listen mit einem Sonderfall wären schwerer zu prüfen als ein eigenes Feld.
 */
export function parseProductCreate(raw: unknown): ProductCreateRequest {
  if (!isPlain(raw)) throw new ProductPayloadError('payload must be an object');
  const { categoryId, stagingIds, ...rest } = raw as {
    categoryId?: unknown; stagingIds?: unknown;
  };
  if (typeof categoryId !== 'string' || categoryId.trim() === '') {
    throw new ProductPayloadError('categoryId is required');
  }
  const data = fields(rest as Record<string, unknown>, CREATE_FIELDS);
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    throw new ProductPayloadError('a product needs a name');
  }
  const ids = stagingIds === undefined || stagingIds === null ? [] : stagingIds;
  if (!Array.isArray(ids)) throw new ProductPayloadError('stagingIds must be a list');
  if (ids.length > MAX_REMOTE_IMAGES) throw new ProductPayloadError(`at most ${MAX_REMOTE_IMAGES} images`);
  for (const id of ids) {
    // Kein Pfad, kein Dateiname, keine URL — nur ein Inhaltshash. Was das nicht ist, wird
    // abgewiesen, bevor daraus irgendwo ein Dateizugriff wird.
    if (!isStagingId(id)) throw new ProductPayloadError('a staged image is named by its content hash');
  }
  if (new Set(ids as string[]).size !== ids.length) {
    throw new ProductPayloadError('the same staged image twice is not an order');
  }
  return { categoryId, data, stagingIds: ids as string[] };
}

export function parseProductUpdate(raw: unknown): { id: string; fields: Record<string, unknown> } {
  if (!isPlain(raw)) throw new ProductPayloadError('payload must be an object');
  const { id, ...rest } = raw as { id?: unknown };
  if (typeof id !== 'string' || !id.trim()) throw new ProductPayloadError('id is required');
  for (const [k, why] of Object.entries(IMMUTABLE_ON_UPDATE)) {
    if (k in (rest as Record<string, unknown>)) throw new ProductPayloadError(why);
  }
  const out = fields(rest as Record<string, unknown>, UPDATE_FIELDS);
  if (Object.keys(out).length === 0) throw new ProductPayloadError('nothing to change');
  return { id, fields: out };
}

/** Typ-Alias aus demselben Grund wie beim Kunden: als `CommandResult` herausgegeben. */
export type ProductCommandResult = {
  productId: string;
  sku: string;
  name: string;
  imageCount: number;
};

/** Wie der Primary an die abgelegten Bytes kommt. Injizierbar, damit ein Test ohne Tauri läuft. */
export type StagedMediaReader = (stagingId: string) => Promise<{ mime: string; dataBase64: string }>;

async function invokeReadStaged(stagingId: string): Promise<{ mime: string; dataBase64: string }> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('staging_media_read', { stagingId });
}

async function invokeDiscardStaged(stagingId: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('staging_media_discard', { stagingId });
}

export interface ProductEngineExtras {
  readStaged?: StagedMediaReader;
  discardStaged?: (stagingId: string) => Promise<void>;
}

export function productEngineDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

export async function runProductCreate(
  deps: EngineDeps,
  identity: CommandIdentity,
  raw: unknown,
  extras: ProductEngineExtras = {},
): Promise<CommandOutcome> {
  const req = parseProductCreate(raw);
  const readStaged = extras.readStaged ?? invokeReadStaged;
  const discard = extras.discardStaged ?? invokeDiscardStaged;

  const outcome = await runRemoteCommand(deps, identity, async () => {
    // Die Bytes werden INNERHALB des Auftrags geholt, und das ist keine Kleinigkeit: eine
    // Wiederholung mit derselben Kennung führt den Handler gar nicht mehr aus. Läge das Lesen
    // davor, scheiterte genau die Wiederholung, für die es die Kennung gibt — die Ablage ist nach
    // dem ersten Erfolg geräumt, und der Client bekäme statt seines eingefrorenen Ergebnisses ein
    // „das Bild ist weg".
    const images: string[] = [];
    for (const id of req.stagingIds) {
      let blob: { mime: string; dataBase64: string };
      try {
        blob = await readStaged(id);
      } catch (e) {
        // Kein Urteil der Domäne: es wird nichts festgehalten, die Transaktion geht zurück. Der
        // Client kann dieselben Bytes erneut ablegen — sie bekommen dieselbe Kennung, weil die
        // Kennung ihr Inhalt ist — und es mit derselben Auftragskennung erneut versuchen.
        throw new ProductPayloadError(`staged image is gone: ${id} (${String(e)})`);
      }
      images.push(`data:${blob.mime};base64,${blob.dataBase64}`);
    }
    const store = useProductStore.getState();
    // Die Nummer vergibt der Primary aus dem durablen Zähler — INNERHALB der Transaktion, damit
    // sie mit dem Produkt zusammen durabel wird oder mit ihm zusammen verschwindet.
    const sku = store.allocateSkuOnCreate(undefined, String(req.data.brand ?? ''), req.categoryId);
    const result = await store.createProductWithMedia(
      { ...req.data, categoryId: req.categoryId, sku } as never,
      undefined,
      undefined,
      { kind: 'data_urls', images },
      // Der Fernauftrag hält den exklusiven Platz bereits: die Aktion darf sich NICHT ein zweites
      // Mal einreihen, sonst wartet sie auf sich selbst.
      { alreadySerialised: true },
    );
    if (result.status !== 'created') {
      // Ein halbes Produkt wird nicht eingefroren. Der Wurf rollt die ganze Transaktion zurück —
      // es bleibt nichts Durables, und derselbe Auftrag darf mit DERSELBEN Kennung wiederholt
      // werden. Die bereits veröffentlichten Bildartefakte sind dann verwaiste Dateien, und für
      // die gibt es die Medien-Müllabfuhr; ein Produkt ohne seine Bilder gibt es nicht.
      throw new CommandNotEvaluated('PRODUCT_MEDIA_INCOMPLETE', `${result.status}: ${result.errorCode}`);
    }
    const value: ProductCommandResult = {
      productId: result.productId,
      sku,
      name: String(req.data.name ?? ''),
      imageCount: images.length,
    };
    return value;
  });

  // Erst wenn der Auftrag wirklich durch ist, verliert die Ablage ihren Zweck. Scheitert das
  // Aufräumen, ist das kein Fehler des Auftrags: der Kehrbesen beim nächsten Start holt es nach.
  if (outcome.kind === 'ok') {
    for (const id of req.stagingIds) {
      try { await discard(id); } catch { /* der Start räumt auf */ }
    }
  }
  return outcome;
}

export function runProductUpdate(deps: EngineDeps, identity: CommandIdentity, raw: unknown): Promise<CommandOutcome> {
  const { id, fields: patch } = parseProductUpdate(raw);
  return runRemoteCommand(deps, identity, async () => {
    const store = useProductStore.getState();
    // Den Artikel muss es geben — sonst liefe ein Edit still ins Leere und meldete Erfolg.
    if (query('SELECT id FROM products WHERE id = ?', [id]).length === 0) {
      throw new CommandRejected('PRODUCT_NOT_FOUND', 'no such product');
    }
    const result = await store.editProductTextDurably(
      id,
      patch as never,
      // Dieselbe Preissperre wie beim Handy, in derselben Transaktion geprüft. Ein Fernauftrag ist
      // kein Grund, sie zu überspringen — im Gegenteil.
      { priceEligibilityRequired: true },
      { alreadySerialised: true },
    );
    if (result.status === 'blocked') {
      // Ein Urteil der Domäne über DIESE Anfrage — die Preissperre ist der Hauptfall. Es wird
      // eingefroren: der Client soll nicht ewig dasselbe erneut schicken, sondern etwas anderes
      // entscheiden.
      throw new CommandRejected(result.errorCode, 'this product may not be changed that way');
    }
    if (result.status !== 'edited') {
      // Konflikt, unvollständig, oder ein Altbestand, der erst umgezogen werden muss: KEIN Urteil.
      // Der Vorgang wurde nie bewertet, nichts ist durabel geworden, dieselbe Kennung darf erneut.
      throw new CommandNotEvaluated(
        result.status === 'cutover_reload' ? 'PRODUCT_CUTOVER_RELOAD' : 'PRODUCT_EDIT_NOT_APPLIED',
        result.status === 'cutover_reload' ? 'legacy product cut over — retry' : String(result.errorCode),
      );
    }
    const after = query('SELECT sku, name FROM products WHERE id = ?', [id])[0];
    const value: ProductCommandResult = {
      productId: id,
      sku: String(after?.sku ?? ''),
      name: String(after?.name ?? ''),
      imageCount: 0,
    };
    return value;
  });
}

// ── Die Anmeldung ─────────────────────────────────────────────────────────

async function execute(
  run: (deps: EngineDeps, identity: CommandIdentity, raw: unknown) => Promise<CommandOutcome>,
  op: string,
  payload: unknown,
  actor?: CommandActor,
): Promise<ProductCommandResult & { replayed: boolean }> {
  if (!actor) throw new Error(`${op} needs an authenticated identity`);
  const body = (payload as { input?: unknown } | null)?.input ?? payload;
  let outcome: CommandOutcome;
  try {
    outcome = await run(productEngineDeps(), { ...actor, op }, body);
  } catch (err) {
    if (err instanceof ProductPayloadError) throw new BusinessError(err.code, err.message);
    throw err;
  }
  if (outcome.kind === 'rejected') {
    // NUR ein EINGEFRORENES Urteil ist ein fachliches Nein. Ein nicht eingefrorenes
    // (`frozen: false`) heißt: der Vorgang wurde nie bewertet — eine Kennungskollision, ein
    // abgebrochener Medienweg, ein Artikel, der erst umgezogen werden muss. Es als Nein zu
    // melden wäre die teuerste Verwechslung dieses Systems: die Oberfläche beendet dann den
    // Versuch, sagt dem Benutzer „abgelehnt" und lässt ihn eine NEUE Kennung nehmen — für einen
    // Vorgang, der noch gar nicht stattgefunden hat. Also weiterreichen als das, was es ist.
    if (!outcome.frozen) throw new CommandNotEvaluated(outcome.code, outcome.message);
    throw new BusinessError(outcome.code, outcome.message);
  }
  return { ...(outcome.value as ProductCommandResult), replayed: outcome.replayed };
}

registerCommand(OP_PRODUCTS_CREATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runProductCreate, OP_PRODUCTS_CREATE, payload, actor),
});

registerCommand(OP_PRODUCTS_UPDATE, {
  kind: 'mutation',
  handler: (payload, actor?: CommandActor) => execute(runProductUpdate, OP_PRODUCTS_UPDATE, payload, actor),
});
