// CENTRAL-C3B — die erste produktive Fernmutation: eine Rechnung anlegen.
//
// Drei Sätze zum Aufbau, weil hier zum ersten Mal ein anderer Rechner echtes Geld bewegt:
//
//  1. **Die Geschäftslogik wird nicht kopiert.** Dieser Befehl ruft dieselbe Funktion, die das
//     Formular auf dem Primary ruft — `createDirectInvoice`. Nummernkreis, Los-Auflösung,
//     Bestandsprüfung, Zeilen, Buchung, Changelog: alles bleibt, wo es ist. Ein zweiter
//     Rechnungspfad wäre eine zweite Wahrheit über Geld.
//  2. **Der Rumpf des Clients ist ein Wunsch, keine Anweisung.** Er darf sagen, WAS ein Mensch
//     gewählt hat — Kunde, Produkt, Los, Menge, Preis, Steuerschema, Notiz, Datum, Mitarbeiter.
//     Er darf NICHT sagen, was daraus folgt: Rechnungsnummer, Filiale, Benutzer, Status, Netto,
//     MwSt, Zeilensumme, Einstandskosten, bezahlter Betrag. Das entsteht hier, auf dem Primary,
//     mit derselben Ableitung wie im Formular (`line-derivation.ts`).
//  3. **Was die Domäne endgültig ablehnt, ist eine Antwort — alles andere eine Störung.** Nur zwei
//     bekannte Urteile werden als fachliches Nein gemeldet und damit eingefroren: der Bestand ist
//     weg, und das Stück ist beim Agenten. Jeder andere Fehler ist eine Störung und hinterlässt
//     keinen Nachweis; sonst würde ein Programmierfehler als „Kunde bekommt keine Rechnung"
//     dauerhaft festgeschrieben.
//
// Bewusst NICHT dabei: Zahlung, Bearbeiten, Löschen, Gutschrift, Reparatur-Nummernkreis
// (`numbering`) und der Agenten-Sonderweg (`allowWithAgent`). Die Rechnung entsteht als PARTIAL
// mit 0 bezahlt — genau wie im Formular, wenn niemand etwas eingibt.

import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import {
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';
import { STOCK_UNAVAILABLE_MESSAGE } from '@/core/lots/lot-availability';
import { getLotsWithPurchaseNumbers } from '@/core/lots/lot-queries';
import { WITH_AGENT_INVOICE_BLOCKED_MESSAGE } from '@/core/products/product-sellability';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { resolveLineScheme, toInvoiceLine, type InvoiceLineInput, type RequestedScheme } from '@/core/invoices/line-derivation';
import { CommandNotEvaluated, CommandRejected, runRemoteCommand, type CommandOutcome, type EngineDeps } from './mutation-engine';
import type { CommandIdentity } from './command-ledger';
import { BusinessError, registerCommand, type CommandActor } from './command-registry';

export const OP_INVOICES_CREATE = 'invoices.create';

/** Was ein Mensch am Bildschirm wählt — mehr nicht. */
interface RemoteLine {
  productId: string;
  lotId?: string | null;
  quantity?: number;
  unitPrice: number;
  scheme?: RequestedScheme;
}

const LINE_KEYS = new Set(['productId', 'lotId', 'quantity', 'unitPrice', 'scheme']);
const TOP_KEYS = new Set(['customerId', 'lines', 'notes', 'issuedDate', 'staffId', 'specialMark']);

/**
 * Felder, die ein Client ausdrücklich NICHT setzen darf. Sie würden alle unbemerkt durchgehen,
 * weil `createDirectInvoice` sie kennt — und jedes einzelne wäre eine andere Art, das Haus zu
 * belügen: eine selbstvergebene Rechnungsnummer, eine fremde Filiale, ein erfundener Einstandspreis
 * (und damit eine erfundene Marge), ein Reparatur-Nummernkreis, der Agenten-Sonderweg.
 */
const FORBIDDEN = [
  'id', 'invoiceNumber', 'branchId', 'tenantId', 'userId', 'createdBy', 'status',
  'paidAmount', 'netAmount', 'vatAmount', 'grossAmount', 'purchasePrice', 'purchasePriceSnapshot',
  'margin', 'marginSnapshot', 'lineTotal', 'vatRate', 'taxScheme', 'stockStatus',
  'numbering', 'allowWithAgent', 'ledger', 'issuedAt',
];

export class InvoicePayloadError extends Error {
  readonly code = 'INVOICE_PAYLOAD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvoicePayloadError';
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvoicePayloadError(`${what} must be a finite number`);
  return v;
};

/**
 * Prüft den Rumpf und gibt zurück, was übrig bleibt. Streng: ein unbekannter Schlüssel wird
 * abgewiesen, statt still ignoriert zu werden — sonst hinge die Sicherheit dieser Grenze daran,
 * dass jemand an jede neue Option gedacht hat.
 */
export function parseInvoicePayload(raw: unknown): {
  customerId: string; lines: RemoteLine[]; notes?: string; issuedDate?: string; staffId?: string; specialMark: boolean;
} {
  if (!isPlain(raw)) throw new InvoicePayloadError('payload must be an object');
  for (const k of Object.keys(raw)) {
    if (FORBIDDEN.includes(k)) throw new InvoicePayloadError(`the primary decides ${k}, not the client`);
    if (!TOP_KEYS.has(k)) throw new InvoicePayloadError(`unknown field: ${k}`);
  }
  const customerId = raw.customerId;
  if (typeof customerId !== 'string' || !customerId.trim()) throw new InvoicePayloadError('customerId is required');
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) throw new InvoicePayloadError('at least one line is required');

  const lines: RemoteLine[] = raw.lines.map((l, i) => {
    if (!isPlain(l)) throw new InvoicePayloadError(`line ${i + 1} must be an object`);
    for (const k of Object.keys(l)) {
      if (FORBIDDEN.includes(k)) throw new InvoicePayloadError(`the primary decides ${k}, not the client (line ${i + 1})`);
      if (!LINE_KEYS.has(k)) throw new InvoicePayloadError(`unknown field in line ${i + 1}: ${k}`);
    }
    if (typeof l.productId !== 'string' || !l.productId.trim()) throw new InvoicePayloadError(`line ${i + 1}: productId is required`);
    const qty = l.quantity === undefined ? 1 : num(l.quantity, `line ${i + 1}: quantity`);
    if (!Number.isInteger(qty) || qty < 1) throw new InvoicePayloadError(`line ${i + 1}: quantity must be a whole number of at least 1`);
    const unitPrice = num(l.unitPrice, `line ${i + 1}: unitPrice`);
    if (unitPrice < 0) throw new InvoicePayloadError(`line ${i + 1}: unitPrice cannot be negative`);
    const scheme = l.scheme;
    if (scheme !== undefined && !['auto', 'VAT_10', 'ZERO', 'MARGIN'].includes(String(scheme))) {
      throw new InvoicePayloadError(`line ${i + 1}: unknown tax scheme`);
    }
    if (l.lotId !== undefined && l.lotId !== null && typeof l.lotId !== 'string') {
      throw new InvoicePayloadError(`line ${i + 1}: lotId must be a string`);
    }
    return { productId: l.productId, lotId: (l.lotId as string | null) ?? null, quantity: qty, unitPrice, scheme: scheme as RequestedScheme };
  });

  if (raw.notes !== undefined && typeof raw.notes !== 'string') throw new InvoicePayloadError('notes must be a string');
  if (raw.staffId !== undefined && typeof raw.staffId !== 'string') throw new InvoicePayloadError('staffId must be a string');
  if (raw.specialMark !== undefined && typeof raw.specialMark !== 'boolean') throw new InvoicePayloadError('specialMark must be true or false');
  if (raw.issuedDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(raw.issuedDate))) {
    throw new InvoicePayloadError('issuedDate must look like YYYY-MM-DD');
  }

  return {
    customerId,
    lines,
    notes: raw.notes as string | undefined,
    issuedDate: raw.issuedDate as string | undefined,
    staffId: raw.staffId as string | undefined,
    specialMark: raw.specialMark === true,
  };
}

/**
 * Aus dem geprüften Wunsch werden die Zeilen, die `createDirectInvoice` erwartet — mit den Werten
 * des HAUSES: das Steuerschema des Produkts, wenn der Client `auto` sagt, und die Einstandskosten
 * aus dem gewählten Los (sonst aus dem Produkt), niemals aus dem Rumpf.
 */
export function buildInvoiceLines(lines: RemoteLine[]): InvoiceLineInput[] {
  return lines.map((l, i) => {
    const rows = query('SELECT id, tax_scheme, purchase_price FROM products WHERE id = ?', [l.productId]);
    const product = rows[0];
    if (!product) throw new InvoicePayloadError(`line ${i + 1}: unknown product`);

    // Das Los wird HIER aufgelöst und dann ausdrücklich mitgegeben — nicht offen gelassen.
    //
    // Der Grund ist eine Lücke, die erst die Ende-zu-Ende-Prüfung gezeigt hat: `createDirectInvoice`
    // sucht sich ohne `lotId` selbst das älteste offene Los, und wenn KEINES mehr offen ist, bucht
    // es die Zeile ohne Los weiter — die Bestandsprüfung überspringt eine Zeile ohne Los, weil es
    // Ware ohne Lose wirklich gibt (Reparaturleistung, Kommission vor dem Auto-Einkauf). Am
    // Formular fällt das nie auf: es gibt immer ein Los mit. Über die Ferne hieße es: das letzte
    // Stück wird zweimal verkauft, beim zweiten Mal ohne Bestandsabzug.
    //
    // Also: Hat das Produkt Lose, MUSS eines davon offen sein. Hat es keine, bleibt alles wie
    // bisher — dieser Befehl ändert die Regeln des Hauses nicht, er füllt nur eine Lücke, die
    // vorher niemand erreichen konnte.
    // Die Liste der konsumierbaren Lose kommt aus DEM Helfer des Hauses — demselben, aus dem das
    // Formular seine Auswahl baut. Damit gibt es keine zweite Zuteilungsregel: „nicht storniert,
    // Restmenge > 0, älteste zuerst" steht an EINER Stelle, und das Formular belegt genauso vor
    // (`lots[0]`), wie hier gewählt wird.
    const open = getLotsWithPurchaseNumbers(l.productId);
    let costBasis = Number(product.purchase_price) || 0;
    let lotId: string | null = null;

    if (l.lotId) {
      const chosen = open.find((x) => x.id === l.lotId);
      if (!chosen) {
        // Gehört das Los überhaupt zu diesem Produkt? Dann ist es leer oder storniert — ein
        // fachliches Nein. Gehört es nicht dazu, ist der Rumpf falsch, und das ist kein Urteil.
        const owned = query('SELECT id FROM stock_lots WHERE id = ? AND product_id = ?', [l.lotId, l.productId]);
        if (owned.length === 0) throw new InvoicePayloadError(`line ${i + 1}: that lot does not belong to this product`);
        throw new CommandRejected('STOCK_UNAVAILABLE', STOCK_UNAVAILABLE_MESSAGE);
      }
      lotId = chosen.id;
      costBasis = chosen.unitCost || costBasis;
    } else if (query('SELECT id FROM stock_lots WHERE product_id = ? LIMIT 1', [l.productId]).length > 0) {
      // Das Produkt WIRD über Lose geführt. Dann muss eines offen sein — sonst hinge die Zeile
      // loslos in der Luft, und die Bestandsprüfung überspringt lose Zeilen (die es zu Recht gibt).
      if (open.length === 0) throw new CommandRejected('STOCK_UNAVAILABLE', STOCK_UNAVAILABLE_MESSAGE);
      lotId = open[0].id;
      costBasis = open[0].unitCost || costBasis;
    }
    // Ware ohne Lose (Reparaturleistung, Kommission vor dem Auto-Einkauf) bleibt wie bisher:
    // kein Los, keine Bestandsprüfung, Einstandskosten aus dem Produkt.

    return toInvoiceLine({
      productId: l.productId,
      lotId,
      quantity: l.quantity ?? 1,
      unitPrice: l.unitPrice,
      costBasis,
      scheme: resolveLineScheme(l.scheme, product.tax_scheme as string | undefined),
    });
  });
}

/**
 * Die zwei Urteile, die die Domäne heute wirklich fällt. Absichtlich eine Liste und kein „alles,
 * was nach einem Geschäftsfehler aussieht": ein Tippfehler im Code darf nicht als endgültiges
 * fachliches Nein eingefroren werden.
 */
const DOMAIN_VERDICTS: ReadonlyArray<readonly [string, string]> = [
  [STOCK_UNAVAILABLE_MESSAGE, 'STOCK_UNAVAILABLE'],
  [WITH_AGENT_INVOICE_BLOCKED_MESSAGE, 'WITH_AGENT_BLOCKED'],
];

export function asDomainVerdict(err: unknown): CommandRejected | null {
  const msg = err instanceof Error ? err.message : String(err);
  for (const [known, code] of DOMAIN_VERDICTS) {
    if (msg === known) return new CommandRejected(code, msg);
  }
  return null;
}

/** Was der Client zurückbekommt. Bewusst schmal: die Nummer, die Kennung, der Betrag. */
export interface InvoiceCreateResult {
  invoiceId: string;
  invoiceNumber: string;
  grossAmount: number;
  status: string;
}

/** Die Transaktionsklammern des Hauses — dieselben, die `beginLedgerTransaction` überall setzt. */
export function invoiceEngineDeps(): EngineDeps {
  return {
    db: getDatabase() as never,
    begin: beginLedgerTransaction,
    commit: commitLedgerTransaction,
    rollback: rollbackLedgerTransaction,
    durableSave: saveDatabaseDurably,
    now: () => new Date().toISOString(),
  };
}

/**
 * Der Befehl selbst. Er läuft INNERHALB der Transaktion des Auftrags: Belegnummer, Rechnung,
 * Zeilen, Bestandsabzug, Buchung und der Nachweis der Kennung teilen ein Schicksal.
 */
export function runInvoiceCreate(deps: EngineDeps, identity: CommandIdentity, rawPayload: unknown): Promise<CommandOutcome> {
  const wish = parseInvoicePayload(rawPayload);
  return runRemoteCommand(deps, identity, () => {
    const lines = buildInvoiceLines(wish.lines);
    try {
      const invoice = useInvoiceStore.getState().createDirectInvoice(
        wish.customerId,
        lines,
        wish.notes,
        wish.issuedDate,
        undefined,          // numbering: der normale Verkaufskreis, nie der Reparaturkreis
        wish.staffId,
        wish.specialMark,
        undefined,          // opts: kein Agenten-Sonderweg über die Ferne
      );
      const result: InvoiceCreateResult = {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        grossAmount: invoice.grossAmount,
        status: invoice.status,
      };
      return result;
    } catch (err) {
      const verdict = asDomainVerdict(err);
      if (verdict) throw verdict;
      throw err;
    }
  });
}

// ── Die Registrierung ─────────────────────────────────────────────────────
//
// Sie steht am Ende dieser Datei und nicht in der Registry: wer den Befehl importiert, bekommt ihn
// vollständig — Vertrag, Prüfung und Anmeldung. `registerCommand` weist ihn ab, wenn sein Name
// nicht ausdrücklich freigegeben ist.


registerCommand(OP_INVOICES_CREATE, {
  kind: 'mutation',
  handler: async (payload, actor?: CommandActor) => {
    if (!actor) throw new Error('invoices.create needs an authenticated identity');
    // Die Bruecke reicht `{ actor, input }` durch — dieselbe Huelle, die auch die Lesebefehle
    // auspacken. Der Rumpf des Clients ist `input`; der Absender kommt NIE daraus, sondern aus
    // dem geprueften Token daneben.
    const body = (payload as { input?: unknown } | null)?.input ?? payload;
    let outcome;
    try {
      outcome = await runInvoiceCreate(invoiceEngineDeps(), { ...actor, op: OP_INVOICES_CREATE }, body);
    } catch (err) {
      // Ein unbrauchbarer Rumpf ist eine Antwort, keine Störung: der Client soll ihn korrigieren
      // und mit einer NEUEN Kennung erneut schicken — nicht dieselbe Anfrage wiederholen.
      if (err instanceof InvoicePayloadError) throw new BusinessError(err.code, err.message);
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
      // Das eingefrorene Urteil wandert als fachliches Nein zurück — inklusive der Wiederholung,
      // die genau dasselbe Nein bekommt.
      throw new BusinessError(outcome.code, outcome.message);
    }
    const value = outcome.value as InvoiceCreateResult;
    return { ...value, replayed: outcome.replayed };
  },
});
