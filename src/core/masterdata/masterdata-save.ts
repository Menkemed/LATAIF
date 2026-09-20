// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — die gemeinsame Speicherfolge der Stammdaten-Masken.
//
// Jede Maske (drei „+ New Supplier", Lieferant ändern und (de)aktivieren, Agent ändern, Partner
// anlegen/ändern, Mitarbeiter anlegen/Status/ändern) ruft EINE Funktion dieser Datei. Die Funktion
// kennt zwei Anschlüsse und keine Geschäftsregel außer der gemeinsamen (`masterdata-rules.ts`):
//
//   • am Primary die Hausfunktion (Store) — in derselben Schreibreihenfolge wie ein Fernauftrag
//     (`runOnPrimary`: exklusiv, eine Transaktion, erst danach durabel). Vorher schrieb die Maske
//     synchron an der Warteschlange vorbei; ein Fernauftrag, der gerade auf etwas wartete (etwa auf
//     die Bytes eines Fotos), hätte ihre Zeile in seine Transaktion genommen.
//   • auf dem Rechner ohne Datenbank die geprüfte Buchung (`suppliers.create`, …) über die Brücke.
//
// Geprüft wird VOR dem Schicken mit derselben Regel, die der Primary anwendet — damit sagt die
// Maske auf beiden Rechnern dasselbe, und ein unbrauchbarer Rumpf verlässt den Rechner gar nicht.
// Beim Ändern reist nur, was sich gegen den geladenen Stand geändert hat (M-01).
// ════════════════════════════════════════════════════════════════════════════
import type { Agent, Employee, Partner, Supplier } from '@/core/models/types';
import { fetchFromPrimary, readsFromPrimary } from '@/core/data/primary-source';
import { runOnPrimary } from '@/core/data/primary-action';
import type { WriteAdapters, WriteOutcome } from '@/core/data/shared-write';
import { updatePayload } from '@/core/data/write-payloads';
import { applyIdentityDocument, assertIdentityOwnerRevision } from '@/core/identity/identity-media';
import { intentOf, prepareIdentityPhoto, SUPPLIER_PHOTO_KEYS } from '@/core/identity/identity-save';
import { useSupplierStore } from '@/stores/supplierStore';
import { useEmployeeStore } from '@/stores/employeeStore';
import { usePartnerStore } from '@/stores/partnerStore';
import { useAgentStore } from '@/stores/agentStore';
import {
  AGENT_UPDATE_FIELDS, EMPLOYEE_FIELDS, PARTNER_UPDATE_FIELDS, SUPPLIER_UPDATE_FIELDS,
  agentUpdateInput, employeeCreateInput, employeeUpdateInput, partnerCreateInput, partnerUpdateInput,
  supplierCreateInput, supplierUpdateInput,
} from './masterdata-rules';

/** Was eine Maske von ihrer Schreibweiche braucht — `useSharedWrite` und `useSharedWrites` passen. */
export interface MasterdataWrite<T> {
  readonly remote: boolean;
  save: (adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
}

export type Saved = { id: string };

function absage<T>(e: unknown): WriteOutcome<T> {
  const code = (e as { code?: unknown })?.code;
  return {
    kind: 'business_error',
    code: typeof code === 'string' && code ? code : 'LOCAL_WRITE_REJECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}

const unveraendert = <T>(value: T): WriteOutcome<T> => ({ kind: 'ok', value, replayed: false });

// Ein Nein des Ausweisvertrags braucht hier KEINE eigene Behandlung: `useSharedWrite` macht aus
// einer geworfenen Ausnahme der lokalen Domäne bereits ein fachliches Nein mit IHREM Code — genau
// so, wie der Fernbefehl eines bewertet. Zwei Übersetzungen wären zwei Antworten auf eine Frage.

/** Nach einem Erfolg auf PC2: den Bestand frisch vom Primary holen, BEVOR die Maske weitermacht —
 *  so ist ein neuer Lieferant sofort in der Auswahl und kann gleich ausgewählt werden. Am Primary
 *  lädt die Hausfunktion ihren Store selbst. */
async function nachladen(op: string, apply: (d: Record<string, unknown>) => void): Promise<void> {
  if (!readsFromPrimary()) return;
  const d = await fetchFromPrimary(op);
  if (d) apply(d);
}

const suppliersNeu = () => nachladen('store.suppliers.get', (d) => useSupplierStore.setState(d as never));
const employeesNeu = () => nachladen('store.employees.get', (d) => useEmployeeStore.setState(d as never));
const partnersNeu = () => nachladen('store.partners.get', (d) => usePartnerStore.setState(d as never));
const agentsNeu = () => nachladen('store.agents.get', (d) => useAgentStore.setState(d as never));

const suppliersHier = () => useSupplierStore.getState().loadSuppliers();
const employeesHier = () => useEmployeeStore.getState().loadEmployees();
const partnersHier = () => usePartnerStore.getState().loadPartners();
const agentsHier = () => useAgentStore.getState().loadAgents();

// ── Lieferant ──────────────────────────────────────────────────────────────

/** „+ New Supplier" — dieselbe Folge an allen drei Stellen (SupplierList, PurchaseCreate, RepairList). */
export async function saveSupplierCreate(
  write: MasterdataWrite<{ supplierId: string }>, form: Partial<Supplier>,
): Promise<WriteOutcome<{ supplierId: string }>> {
  let input: ReturnType<typeof supplierCreateInput>;
  try { input = supplierCreateInput(form as Record<string, unknown>); } catch (e) { return absage(e); }
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (k !== 'cprImage') body[k] = v;
  // MEDIA-IDENTITY §3 — das Ausweisfoto wird ein MEDIUM: am Primary hier aufgenommen, auf PC2 in
  // die Zwischenablage gelegt. In die Lieferantenzeile geht es nicht mehr.
  const foto = await prepareIdentityPhoto(
    write.remote, 'supplier', intentOf(input.cprImage ?? undefined), SUPPLIER_PHOTO_KEYS,
  );
  if (foto.kind === 'fail') return foto.outcome;
  if (foto.kind === 'ready') Object.assign(body, foto.body);
  const mediaId = foto.kind === 'ready' ? foto.mediaId : null;
  const r = await write.save({
    local: () => runOnPrimary(() => {
      const s = useSupplierStore.getState().createSupplier({ ...input, cprImage: undefined });
      // Die Zeile ist gerade entstanden — das Anlegen IST die Änderung, keine zweite Fassung.
      if (mediaId) applyIdentityDocument('supplier', s.id, mediaId, { bumpOwner: false });
      return { supplierId: s.id };
    }, suppliersHier),
    remote: () => body,
    shape: (v) => ({ supplierId: String(v.supplierId ?? '') }),
  });
  if (r.kind === 'ok') await suppliersNeu();
  return r;
}

/**
 * CUSTOMER-SUPPLIER-ROLE-LINK — „New Supplier → Use existing customer". Am Primary die Hausfunktion,
 * auf PC2 derselbe Befehl `suppliers.create` mit der Kunden-Kennung. Die Identität kommt in beiden
 * Fällen aus der Kundenzeile des Primary; die Maske schickt nur, was ein Lieferant zusätzlich braucht.
 */
export async function saveSupplierFromCustomer(
  write: MasterdataWrite<{ supplierId: string; existing: boolean }>,
  customer: { id: string; updatedAt: string },
  extras: { address?: string; notes?: string; createDespiteExistingSuppliers?: boolean },
): Promise<WriteOutcome<{ supplierId: string; existing: boolean }>> {
  const body: Record<string, unknown> = { linkedCustomerId: customer.id, linkedCustomerUpdatedAt: customer.updatedAt };
  for (const k of ['address', 'notes'] as const) { const v = extras[k]; if (typeof v === 'string' && v.trim()) body[k] = v.trim(); }
  if (extras.createDespiteExistingSuppliers === true) body.createDespiteExistingSuppliers = true;
  const r = await write.save({
    local: () => runOnPrimary(() => {
      const out = useSupplierStore.getState().createSupplierFromCustomer(customer.id, body, customer.updatedAt);
      return { supplierId: out.supplier.id, existing: out.existing };
    }, suppliersHier),
    remote: () => body,
    shape: (v) => ({ supplierId: String(v.supplierId ?? ''), existing: v.existing === true }),
  });
  if (r.kind === 'ok') await suppliersNeu();
  return r;
}

/**
 * CUSTOMER-SUPPLIER-ROLE-LINK V2 — einen bestehenden, unverknüpften Lieferanten ausdrücklich als
 * Lieferanten-Rolle dieses Kunden bestätigen. Auf PC2 `suppliers.update` mit der Kunden-Kennung.
 * Nur `linked_customer_id` wird gesetzt — keine Einkäufe, Verbindlichkeiten oder Buchungen.
 */
export async function saveSupplierLinkToCustomer(
  write: MasterdataWrite<{ supplierId: string; existing: boolean }>,
  supplierId: string,
  customer: { id: string; updatedAt: string },
): Promise<WriteOutcome<{ supplierId: string; existing: boolean }>> {
  const body: Record<string, unknown> = { id: supplierId, linkedCustomerId: customer.id, linkedCustomerUpdatedAt: customer.updatedAt };
  const r = await write.save({
    local: () => runOnPrimary(() => {
      const out = useSupplierStore.getState().linkSupplierToCustomer(supplierId, customer.id, customer.updatedAt);
      return { supplierId: out.supplier.id, existing: out.existing };
    }, suppliersHier),
    remote: () => body,
    shape: (v) => ({ supplierId: String(v.supplierId ?? ''), existing: v.existing === true }),
  });
  if (r.kind === 'ok') await suppliersNeu();
  return r;
}

/** Lieferant ändern: nur das Geänderte; ein neues Foto reist über die Ablage, ein entferntes als `null`. */
export async function saveSupplierUpdate(
  write: MasterdataWrite<Saved>, base: Supplier, form: Partial<Supplier>,
): Promise<WriteOutcome<Saved>> {
  const diff = updatePayload(base as unknown as Record<string, unknown>, form as Record<string, unknown>, SUPPLIER_UPDATE_FIELDS);
  // MEDIA-IDENTITY §3 — der Wunsch zum Dokument ZUERST: ein Entfernen steht nicht im Vergleich mit
  // der Zeile (die Spalte ist leer, seit das Dokument ein Medium ist), und ein Abbruch auf „nichts
  // geändert“ hätte es lautlos verschluckt.
  const wunschVorab = intentOf((form as { cprImage?: string | null }).cprImage);
  if (Object.keys(diff).length === 0 && wunschVorab.kind === 'unchanged') return unveraendert({ id: base.id });
  try { supplierUpdateInput(diff); } catch (e) { return absage(e); }
  // MEDIA-IDENTITY §3/§9 — der Wunsch zum Ausweisdokument kommt aus dem FORMULAR, nicht aus dem
  // Vergleich mit der Zeile. Der Vergleich kann ihn gar nicht sehen: die Spalte ist leer, seit das
  // Dokument ein Medium ist, und „leer gegen entfernt" gilt dort als unveraendert. Ein Entfernen
  // waere damit lautlos verschwunden.
  const wunsch = wunschVorab;
  const zeilenFelder = { ...diff }; delete zeilenFelder.cprImage;
  const body: Record<string, unknown> = { id: base.id, ...zeilenFelder };
  const foto = await prepareIdentityPhoto(write.remote, 'supplier', wunsch, SUPPLIER_PHOTO_KEYS, base.id);
  if (foto.kind === 'fail') return foto.outcome;
  if (foto.kind === 'ready') {
    Object.assign(body, foto.body);
    // Der Stand, den der Bildschirm gesehen hat — ohne ihn nimmt der Primary die Änderung nicht an.
    body.expectedRevision = base.revision ?? 1;
  }
  const mediaId = foto.kind === 'ready' ? foto.mediaId : null;
  const aendertDokument = foto.kind === 'ready';
  const r = await write.save({
    local: () => runOnPrimary(() => {
      if (aendertDokument) {
        assertIdentityOwnerRevision('supplier', base.id, base.revision ?? 1);
        applyIdentityDocument('supplier', base.id, mediaId, { bumpOwner: Object.keys(zeilenFelder).length === 0 });
      }
      if (Object.keys(zeilenFelder).length > 0) {
        useSupplierStore.getState().updateSupplier(base.id, zeilenFelder as Partial<Supplier>);
      }
      return { id: base.id };
    }, suppliersHier),
    remote: () => body,
    shape: () => ({ id: base.id }),
  });
  if (r.kind === 'ok') await suppliersNeu();
  return r;
}

/** „Deactivate / Reactivate Supplier" — der ZIELWERT, kein Umschalter. */
export function saveSupplierActive(write: MasterdataWrite<Saved>, supplier: Supplier, active: boolean): Promise<WriteOutcome<Saved>> {
  // MEDIA-IDENTITY §3 — `cprImage` ausdruecklich NICHT mitgeben: im Formular heisst das Feld „das
  // neue Ausweisfoto", und der Altbestand eines Lieferanten steht genau dort. Wer ihn mitschickte,
  // liesse jedes Aktivieren sein altes Bild erneut aufnehmen und verknuepfen.
  return saveSupplierUpdate(write, supplier, { ...supplier, cprImage: undefined, active });
}

// ── Agent ──────────────────────────────────────────────────────────────────

export async function saveAgentUpdate(write: MasterdataWrite<Saved>, base: Agent, form: Partial<Agent>): Promise<WriteOutcome<Saved>> {
  const diff = updatePayload(base as unknown as Record<string, unknown>, form as Record<string, unknown>, AGENT_UPDATE_FIELDS);
  if (Object.keys(diff).length === 0) return unveraendert({ id: base.id });
  try { agentUpdateInput(diff); } catch (e) { return absage(e); }
  const r = await write.save({
    local: () => runOnPrimary(() => { useAgentStore.getState().updateAgent(base.id, diff as Partial<Agent>); return { id: base.id }; }, agentsHier),
    remote: () => ({ id: base.id, ...diff }),
    shape: () => ({ id: base.id }),
  });
  if (r.kind === 'ok') await agentsNeu();
  return r;
}

// ── Partner ────────────────────────────────────────────────────────────────

export async function savePartnerCreate(write: MasterdataWrite<Saved>, form: Partial<Partner>): Promise<WriteOutcome<Saved>> {
  let input: ReturnType<typeof partnerCreateInput>;
  try { input = partnerCreateInput(form as Record<string, unknown>); } catch (e) { return absage(e); }
  const r = await write.save({
    local: () => runOnPrimary(() => ({ id: usePartnerStore.getState().createPartner(input).id }), partnersHier),
    remote: () => ({ ...input }),
    shape: (v) => ({ id: String(v.partnerId ?? '') }),
  });
  if (r.kind === 'ok') await partnersNeu();
  return r;
}

export async function savePartnerUpdate(write: MasterdataWrite<Saved>, base: Partner, form: Partial<Partner>): Promise<WriteOutcome<Saved>> {
  const diff = updatePayload(base as unknown as Record<string, unknown>, form as Record<string, unknown>, PARTNER_UPDATE_FIELDS);
  if (Object.keys(diff).length === 0) return unveraendert({ id: base.id });
  try { partnerUpdateInput(diff); } catch (e) { return absage(e); }
  const r = await write.save({
    local: () => runOnPrimary(() => { usePartnerStore.getState().updatePartner(base.id, diff as Partial<Partner>); return { id: base.id }; }, partnersHier),
    remote: () => ({ id: base.id, ...diff }),
    shape: () => ({ id: base.id }),
  });
  if (r.kind === 'ok') await partnersNeu();
  return r;
}

// ── Mitarbeiter ────────────────────────────────────────────────────────────

export async function saveEmployeeCreate(write: MasterdataWrite<Saved>, form: Partial<Employee>): Promise<WriteOutcome<Saved>> {
  let input: ReturnType<typeof employeeCreateInput>;
  try { input = employeeCreateInput(form as unknown as Record<string, unknown>); } catch (e) { return absage(e); }
  const r = await write.save({
    local: () => runOnPrimary(() => ({ id: useEmployeeStore.getState().createEmployee(input as never).id }), employeesHier),
    remote: () => ({ ...input }),
    shape: (v) => ({ id: String(v.employeeId ?? '') }),
  });
  if (r.kind === 'ok') await employeesNeu();
  return r;
}

/** Mitarbeiter ändern — auch „On Leave" / „Reactivate" in Liste und Detail (nur der Status reist). */
export async function saveEmployeeUpdate(write: MasterdataWrite<Saved>, base: Employee, form: Partial<Employee>): Promise<WriteOutcome<Saved>> {
  const diff = updatePayload(base as unknown as Record<string, unknown>, form as Record<string, unknown>, EMPLOYEE_FIELDS);
  if (Object.keys(diff).length === 0) return unveraendert({ id: base.id });
  try { employeeUpdateInput(diff); } catch (e) { return absage(e); }
  const r = await write.save({
    local: () => runOnPrimary(() => { useEmployeeStore.getState().updateEmployee(base.id, diff as Partial<Employee>); return { id: base.id }; }, employeesHier),
    remote: () => ({ id: base.id, ...diff }),
    shape: () => ({ id: base.id }),
  });
  if (r.kind === 'ok') await employeesNeu();
  return r;
}
