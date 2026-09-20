// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — die zwei Anschlüsse der Edelmetall- und Altgold-Masken.
//
//   • `…OnPrimary` — die Hausfolge (`metal-house.ts`, `scrap-house.ts`) am Primary: exklusiv, in
//     EINER Transaktion, erst danach durabel; danach lesen die Listen neu.
//   • `…Body`      — der Rumpf, den dieselbe Maske auf PC2 an den Primary schickt. Er nennt nur,
//     was der Mensch eingegeben hat; Spot, Schmelzwert, Nummer, Summen, Status und Fassung
//     bestimmt der Primary.
//
// Eine eigene Datei, weil die Stores ihrerseits die Hausfolge rufen (EINE Implementierung für die
// alten, synchronen Einstiege): lägen die Nachlade-Aufrufe im Haus, hinge Store an Haus an Store.
// ════════════════════════════════════════════════════════════════════════════
import { resolveScrapPhotoSlots, type PhotoSlotRequest } from '@/core/metals/scrap-media';
import { runOnPrimary } from '@/core/data/primary-action';
import { stageRecordDataUrls } from '@/core/bridge/client-staging-upload';
import { useMetalStore } from '@/stores/metalStore';
import { useScrapTradeStore } from '@/stores/scrapTradeStore';
import { useExpenseStore } from '@/stores/expenseStore';
import {
  METAL_CREATE_FIELDS, changeMetalStatusInHouse, createMetalInHouse, localHouseBranch, setSpotPriceInHouse,
  type MetalCreateInput, type MetalStatusChange, type MetalStatusResult,
} from './metal-house';
import {
  cancelScrapTradeInHouse, createScrapTradeInHouse, updateScrapTradeInHouse,
  type ScrapTradeInput, type ScrapTradeResult,
} from './scrap-house';

// ── Edelmetall ─────────────────────────────────────────────────────────────

/** Nach jeder Metallhandlung: die Liste und (wegen der A/P-Ausgabe) die Ausgaben — auch nach einem Rollback. */
function metalleNeuLesen(): void {
  useMetalStore.getState().loadMetals();
  try { useExpenseStore.getState().loadExpenses(); } catch { /* keine Ausgabenansicht geladen */ }
}

export interface MetalCreatedValue { metalId: string; revision: number; linkedExpenseId: string | null }

/** „Add Item" am Primary. */
export function createMetalOnPrimary(input: Partial<MetalCreateInput>): Promise<MetalCreatedValue> {
  return runOnPrimary(() => {
    const r = createMetalInHouse(input, localHouseBranch());
    return { metalId: r.metal.id, revision: r.metal.revision, linkedExpenseId: r.linkedExpenseId ?? null };
  }, metalleNeuLesen);
}

/** „Mark Sold" / „Confirm Melt" am Primary — mit der Fassung, die die Liste gezeigt hat. */
export function changeMetalStatusOnPrimary(req: MetalStatusChange): Promise<MetalStatusResult> {
  return runOnPrimary(() => changeMetalStatusInHouse(req, localHouseBranch()), metalleNeuLesen);
}

/** Einen Spotpreis übernehmen (Verlassen des Feldes / Enter) am Primary. */
export function setSpotPriceOnPrimary(metalType: string, price: number): Promise<{ metalType: string; price: number }> {
  return runOnPrimary(() => setSpotPriceInHouse(metalType, price, localHouseBranch()), () => { /* keine Liste betroffen */ });
}

const leer = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Der Rumpf von „Add Item" auf PC2: nur die Eingaben der Maske, ohne leere Felder. */
export function metalCreateBody(form: Partial<MetalCreateInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of METAL_CREATE_FIELDS) {
    const v = (form as Record<string, unknown>)[k];
    if (!leer(v)) out[k] = v;
  }
  return out;
}

export function metalStatusBody(
  metalId: string, expectedRevision: number, status: 'sold' | 'melted', salePrice?: number, paymentMethod?: string,
): Record<string, unknown> {
  if (status !== 'sold') return { metalId, expectedRevision, status };
  return paymentMethod ? { metalId, expectedRevision, status, salePrice, paymentMethod } : { metalId, expectedRevision, status, salePrice };
}

export function spotPriceBody(metalType: string, price: number): Record<string, unknown> {
  return { metalType, price };
}

// ── Altgold ────────────────────────────────────────────────────────────────

function geschaefteNeuLesen(): void {
  useScrapTradeStore.getState().loadTrades();
}

/**
 * „Save Trade" am Primary. POST-PARITY R7B PP-12 — jedes Foto durch den EINEN Normalisierer, wie fern —
 * VOR der Klammer: das Umrechnen hält die Schreibreihenfolge des Primary nicht auf.
 */
export async function createScrapTradeOnPrimary(input: ScrapTradeInput): Promise<ScrapTradeResult> {
  const photos = await mitMedien(input);
  return runOnPrimary(() => createScrapTradeInHouse(photos, localHouseBranch()), geschaefteNeuLesen);
}

/** „Save Changes" am Primary — gegen die Fassung, die die Detailseite geladen hat. Gespeicherte Fotos bleiben. */
export async function updateScrapTradeOnPrimary(tradeId: string, expectedVersion: number, input: ScrapTradeInput): Promise<ScrapTradeResult> {
  const photos = await mitMedien(input, tradeId);
  return runOnPrimary(() => updateScrapTradeInHouse(tradeId, expectedVersion, photos, localHouseBranch()), geschaefteNeuLesen);
}

/** „Yes, Cancel Trade" am Primary. */
export function cancelScrapTradeOnPrimary(tradeId: string, expectedVersion: number): Promise<ScrapTradeResult> {
  return runOnPrimary(() => cancelScrapTradeInHouse(tradeId, expectedVersion, localHouseBranch()), geschaefteNeuLesen);
}

/** Die abgelegten Fotos je Zeile — in der Reihenfolge der Maske. */
/**
 * MEDIA-SCRAP — der Wunsch der Maske wird zu MEDIENKENNUNGEN, VOR der Klammer.
 *
 * Was die Maske hält, ist eine Mischung: schon gespeicherte Medien (`media-…`) und frische
 * Aufnahmen (Daten-URLs). Die einen bleiben, die anderen werden hier aufgenommen — geprüft,
 * normalisiert, veröffentlicht. Die Reihenfolge bleibt die der Maske.
 */
function slotsOf(list: readonly string[] | undefined): PhotoSlotRequest[] {
  return (list ?? []).map((x) => (x.startsWith('data:') ? { dataUrl: x } : { keep: x }));
}

async function mitMedien(input: ScrapTradeInput, tradeId?: string): Promise<ScrapTradeInput> {
  const lines: ScrapTradeInput['lines'] = [];
  for (const l of input.lines) {
    lines.push({
      ...l,
      imagesPurchase: await resolveScrapPhotoSlots(slotsOf(l.imagesPurchase), 'purchase', undefined, tradeId),
      imagesSale: await resolveScrapPhotoSlots(slotsOf(l.imagesSale), 'sale', undefined, tradeId),
    });
  }
  return { ...input, lines };
}

/** Je Zeile und Seite: was bleibt (Medienkennung) und was neu abgelegt wurde (Inhaltskennung). */
export interface StagedScrapPhotos { purchase: ScrapPhotoSlot[]; sale: ScrapPhotoSlot[] }
export type ScrapPhotoSlot = { keep: string } | { stagingId: string };

/**
 * Auf PC2 reisen Fotos nie im Auftrag: die Bytes gehen zuerst in die vorhandene Zwischenablage des
 * Primary (R5B), der Auftrag nennt nur ihre Kennungen. Beim Ändern werden auch die schon
 * gespeicherten Fotos neu abgelegt — derselbe Inhalt ergibt dieselbe Kennung, es entsteht nichts
 * doppelt, und das Haus ersetzt die Zeilen samt Fotos wie am Primary.
 * POST-PARITY R7B PP-12 — neue Fotos rechnet PC2 vorher durch den Normalisierer; die gespeicherten
 * (`keep`) reisen unverändert, damit der Primary sie an ihrer Kennung wiedererkennt.
 */
export async function stageScrapPhotos(
  input: ScrapTradeInput,
  stage?: (urls: readonly string[]) => Promise<string[]>,
  keep: readonly string[] = [],
): Promise<StagedScrapPhotos[]> {
  stage ??= (urls) => stageRecordDataUrls(urls, keep);
  // MEDIA-SCRAP — NUR neue Aufnahmen gehen in die Ablage. Ein schon gespeichertes Foto ist eine
  // Medienkennung und reist als `keep`: es noch einmal hochzuladen wäre Arbeit für nichts und
  // brächte die Reihenfolge durcheinander, in der der Mensch seine Bilder sortiert hat.
  const seite = async (list: readonly string[] | undefined): Promise<ScrapPhotoSlot[]> => {
    const werte = list ?? [];
    const neu = werte.filter((x) => x.startsWith('data:'));
    const ids = neu.length ? await stage(neu) : [];
    let i = 0;
    return werte.map((x) => (x.startsWith('data:') ? { stagingId: ids[i++] } : { keep: x }));
  };
  const out: StagedScrapPhotos[] = [];
  for (const l of input.lines) out.push({ purchase: await seite(l.imagesPurchase), sale: await seite(l.imagesSale) });
  return out;
}

function scrapFields(input: ScrapTradeInput, staged: readonly StagedScrapPhotos[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    sellerName: input.sellerName,
    buyerName: input.buyerName,
    tradeDate: input.tradeDate,
  };
  // Beim Ändern ersetzt das Haus den ganzen Datensatz: ein weggelassenes Feld ist ein geleertes.
  for (const k of ['sellerPhone', 'sellerCustomerId', 'buyerPhone', 'buyerSupplierId', 'notes'] as const) {
    if (!leer(input[k])) out[k] = input[k];
  }
  out.lines = input.lines.map((l, i) => {
    const line: Record<string, unknown> = {
      weightGrams: l.weightGrams, karat: l.karat, purchasePrice: l.purchasePrice, salePrice: l.salePrice,
    };
    if (!leer(l.notes)) line.notes = l.notes;
    // MEDIA-SCRAP — die bleibende Kennung DIESER Position reist mit, damit der Primary die Fotos
    // wiederfindet, nachdem er die Zeilen ersetzt hat. Eine neue Zeile hat noch keine.
    if (!leer(l.lineKey)) line.lineKey = l.lineKey;
    const s = staged[i];
    if (s?.purchase.length) line.purchasePhotos = [...s.purchase];
    if (s?.sale.length) line.salePhotos = [...s.sale];
    return line;
  });
  out.paymentsOut = input.paymentsOut.map((p) => ({ method: p.method, amount: p.amount }));
  out.paymentsIn = input.paymentsIn.map((p) => ({ method: p.method, amount: p.amount }));
  return out;
}

export function scrapCreateBody(input: ScrapTradeInput, staged: readonly StagedScrapPhotos[] = []): Record<string, unknown> {
  return scrapFields(input, staged);
}

export function scrapUpdateBody(tradeId: string, expectedVersion: number, input: ScrapTradeInput, staged: readonly StagedScrapPhotos[] = []): Record<string, unknown> {
  return { tradeId, expectedVersion, ...scrapFields(input, staged) };
}

export function scrapCancelBody(tradeId: string, expectedVersion: number): Record<string, unknown> {
  return { tradeId, expectedVersion };
}
