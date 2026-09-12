// CENTRAL-UI-PARITY R6B — das Rechnungsdatum, EINE Regel für beide Wege.
//
// Die Maske gibt `YYYY-MM-DDT00:00:00.000Z`, der Fernauftrag `YYYY-MM-DD` (so prüft ihn
// `parseInvoicePayload`). Beim ANLEGEN glich `createDirectInvoice` das schon aus; beim ÄNDERN nicht —
// je nach Rechner stand in `issued_at` ein anderer Wert. Ein reines Datum wird Mitternacht UTC.
export function issuedAtIso(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return v.includes('T') ? v : `${v}T00:00:00.000Z`;
}
