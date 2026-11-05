# Listen-Navigation: Suche, Filter, Sortierung und Position bei „Back“ (v0.8.98)

Stand 05.11.2026. Gemeinsame Lösung für alle Listen; gleiches Verhalten am Primary und am PC2. Nur Oberfläche:
keine Datenbank, kein Sync, keine Geschäftslogik.

## Verhalten

- **Back** (ein Schritt zurück im Verlauf) bringt die Liste so zurück, wie sie verlassen wurde: Suchtext (sichtbar
  im Feld), alle Filter, Sortierung, Ansicht und Scroll-Position.
- **Normale Navigation** (Seitenleiste, Link, neuer Schritt) öffnet die Liste frisch und oben.
- **Scroll-Position** wird erst gesetzt, wenn der Inhalt sie zulässt; ist die Liste kürzer geworden, auf die letzte
  gültige Position begrenzt. Bis dahin bleibt der Inhalt unsichtbar — kein sichtbares Springen.
- **Suchfelder** zeigen immer den aktiven Suchtext und haben ein „×“ zum Löschen.
- **Nach dem Löschen** eines Eintrags (alle Detailseiten mit Löschen: Reparaturen, Rechnungen, Collection, Clients,
  Aufträge, Consignments, Credit Notes, Offers, Production, Scrap Trades, Suppliers): kam man direkt aus
  der Liste, geht es dorthin zurück (mit Suche, Filtern, Position); sonst frisch zur Liste wie bisher. Davor liegende
  Bearbeiten-Seiten des gelöschten Eintrags werden nie angesprungen. Sperren und Löschabläufe sind unverändert.
  - Einkäufe haben kein Löschen: sie werden storniert und bleiben als Beleg auf ihrer Detailseite; „Back" führt
    danach wie überall zur Liste wie verlassen.
- Der Zustand liegt nur im Arbeitsspeicher; nach einem Neustart der App ist er leer.

## Technik

| Baustein | Datei |
|---|---|
| Speicher je Verlaufsschritt (`pathname#location.key`, max. 80) und Verlauf `idx → pathname` | `src/core/ui/list-nav-memory.ts` |
| `useListState` (statt `useState`), `useListScrollRestore`, `useNavigationTrail`, `useReturnToList` | `src/hooks/useListNav.ts` |
| Scroll je Seite, Suchfeld mit `searchValue` und „×“ | `src/components/layout/PageLayout.tsx`, `src/components/ui/SearchClearButton.tsx` |
| Verlauf mitschreiben (immer sichtbar) | `src/components/layout/Sidebar.tsx` |

## Abdeckung der 30 Routen (ohne Detail-, Neu- und Bearbeiten-Seiten)

**Mit Listenzustand (23)** — Suche/Filter/Sortierung/Ansicht und Scroll:

| Route | Seite | Gemerkter Zustand |
|---|---|---|
| `/clients` | CustomerList | Suche |
| `/collection` | WatchList | Suche, Kategorie, Status, Own/Consignment/All |
| `/offers` | OfferList | Status, Suche |
| `/invoices` | InvoiceList | Suche (Status, Kunde, Mitarbeiter wie bisher über die URL) |
| `/repairs` | RepairList | Status, Kunde, Mitarbeiter, Sortierung, Arbeitsart, Quelle, Werkstatt, Fallback, Rechnung, Suche |
| `/scrap-trades` | ScrapTradeList | Suche (eigenes Feld mit „×“), Status |
| `/consignments` | ConsignmentList | Suche, Status, Reiter |
| `/agents` | AgentList | Reiter; Transfer-Tabelle: Status (Komponente, auch in AgentDetail) |
| `/metals` | MetalList | Status, Suche |
| `/old-stock` | OldStockPage | Filter |
| `/orders` | OrderList | Status, Typ, Suche |
| `/documents` | DocumentList | Klasse, Ansicht |
| `/tasks` | TaskList | Status, Priorität, Typ, Suche |
| `/debts` | DebtsPage | Nur überfällige, Filter, Suche |
| `/receivables` | ReceivablesPage | Suche, Quellen, Nur überfällige |
| `/employees` | EmployeeList | Suche, Status |
| `/suppliers` | SupplierList | Suche, Inaktive zeigen |
| `/purchases` | PurchaseList | Suche, Filter |
| `/expenses` | ExpenseList | Suche, Kategorie |
| `/payables` | PayablesPage | Suche, Typen, Nur überfällige |
| `/banking` | BankingPage | Konto, Typ |
| `/partners` | PartnersPage | Suche |
| `/credit-notes` | CreditNoteList | Suche |

**Nur Scroll-Position (4)** — keine Filter: `/bulk-metals`, `/opening-balances`, `/production`, `/business-reports`.

**Ohne Wiederherstellung (3)** — keine Listen, eigenes Layout ohne `PageLayout`: `/` (Dashboard), `/analytics`,
`/reconciliation`.

Dazu: Production und Scrap Trades gehen bei „Back“ jetzt einen Schritt zurück (vorher harter Sprung zur Liste).

## Nachweise

- `test/list-nav/list-nav.test.ts` — Speicher, Scroll-Grenzen, Rückweg nach dem Löschen, Verträge aller Seiten.
- `test/e2e/list-back-state.e2e.mjs` — zwei echte Apps (Primary und PC2), echte Maus/Tastatur/Mausrad: Reparaturen,
  Collection, Clients (Back, kein Springen, „×“, normale Navigation), Löschen am Primary (Reparatur, Artikel, Kunde).
