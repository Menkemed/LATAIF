# CENTRAL-UI-PARITY — dieselbe Oberfläche auf Primary und DB-losem Client

Stand: 08.09.2026, über `598b512` (v0.8.54). Alle Zahlen sind aus dem aktuellen `main` gemessen,
nicht aus früheren Berichten übernommen.

## 1. Die reale Oberfläche (gemessen)

| Größe | Wert |
|---|---|
| Routen in `App.tsx` | 55 (alle auf eine Datei auflösbar) |
| Seitendateien unter `src/pages` | 69 |
| Stores | 28, davon 27 mit Ladefunktionen (37 Ladefunktionen) |
| Seiten mit **direktem** Datenbankzugriff | 4 |
| Komponenten mit direktem Datenbankzugriff | 2 |
| Stores mit direktem Datenbankzugriff | 26 |

Der entscheidende Befund: die Oberfläche liest fast überall **über Stores**. Damit liegt der Hebel
für Parität unter den Seiten, nicht in ihnen — es mussten nicht 55 Routen umgebaut werden, sondern
eine Schicht.

Die vier Seiten mit direktem Zugriff sind `RepairFlowTestPage`, `AnalyticsPage`, `OnboardingPage`,
`SettingsPage`; die zwei Komponenten sind `StockCheckInventoryModal` und `SyncDuplicateGuard`.
Sie sind die Ausreißer und stehen unten unter „Lücken“.

## 2. Gemeinsame Oberfläche statt zweiter Oberfläche

`ClientShell` ist ab jetzt **nur noch** Verbinden, Anmelden und Fehlerzustand. Nach erfolgreicher
Anmeldung rendert `App.tsx` dieselbe Anwendung wie am Primary: dieselbe `BrowserRouter`-Struktur,
dieselbe Seitenleiste, dieselben Seiten, dasselbe Styling. Es gibt keine Kopie einer Seite unter
`components/client/*` mehr im Wirkbetrieb — die dortigen Masken bleiben vorerst als
Lebenszyklus-Tafeln bestehen, werden aber nach dem Login nicht mehr gerendert.

Die Sitzung entsteht auf PC2 aus dem geprüften Ausweis (`core/auth/client-session.ts`), nicht aus
einer Benutzertabelle. Sie ist reine Anzeige: der Primary prüft bei **jeder** Anfrage erneut und
liest die Rolle frisch aus der Benutzertabelle (C4 FINAL).

## 3. Datenzugriff hinter den Stores

```
Seite → bestehender Store-Vertrag → lokal (Primary)  |  fern (Client)
```

`core/data/primary-source.ts` ist die eine Weiche. In einer Ladefunktion steht genau eine Zeile:

```ts
if (hydrateFromPrimary('store.products.get', (d) => set(d as never))) return;
```

Am Primary liefert sie `false` — alles bleibt, wie es war. Auf PC2 holt sie den Datenstand über
eine benannte Store-Auskunft und setzt ihn in den Store; die Seite zeichnet sich neu.

**Kein** generischer SQL-Ausführer, **kein** Datenbankspiegel, **keine** zweite Autorität: der
Client nennt einen Store-Namen aus einer festen Liste, und der Primary füllt ihn, indem er **seine
eigene Ladefunktion** ausführt. Gleichstand ist damit Bauart, nicht Absicht.

## 4. Lese-Abdeckung

25 Store-Auskünfte (`store.<name>.get`), verdrahtet in 25 Stores. Registry damit:

| Klasse | Anzahl |
|---|---|
| Probe | 1 |
| C2-Auskünfte (`*.list` / `*.get`) | 18 |
| Store-Auskünfte (`store.*.get`) | 25 |
| Buchungen | 40 (**unverändert**) |
| **Rust `REMOTE_OPS`** | **84** |

Abgedeckt: Artikel/Kategorien, Kunden, Rechnungen, Lieferanten, Einkäufe (inkl. Retouren und
Eingang), Aufträge, Kommissionen, Reparaturen, Agenten/Transfers, Verkaufsretouren, Gutschriften,
Ausgaben, wiederkehrende Ausgaben, Verbindlichkeiten, Schulden, Banking, Gold, Metalle,
Schrotthandel, Angebote, Produktion, Partner, Mitarbeiter, Aufgaben, Dokumente.

**Vertragsänderung, ausdrücklich benannt:** Die 18 C2-Auskünfte folgen dem Grundsatz „die Antwort
ist eine Form, keine Tabelle“. Für dieselbe Oberfläche trägt er nicht — dieselbe Seite zeigt
dieselben Felder. Die Store-Auskünfte liefern deshalb den Datenstand des Stores. Das ist keine
Rechteausweitung: PC2 zeigt genau das, was derselbe Benutzer am Primary vor sich hätte.

## 5. Schreiben — Lückenmatrix

Bestehende geprüfte Fernbuchungen: **40, unverändert**. Sie decken ab: Rechnung (anlegen, ändern,
Zahlungen, Gutschrift-Anwendung), Kunde, Artikel, Einkauf, Auftrag (inkl. Status, Zahlungen,
Umwandlung), Kommission (inkl. Verkauf, Auszahlung, Rückgabe), Reparatur (inkl. Zustand, Zeilen,
Rechnung), Agenten-Transfer (inkl. Umwandlung), Rückgabe/Erstattung.

Ohne Fernbuchung — und damit auf PC2 **nicht** ausführbar:

- Löschen (Rechnung, Einkauf, Reparatur …): hat einen eigenen Referenzvertrag, bewusst nie fern
- Angebote, Produktion, Schrotthandel, Banking, Partner, Gold/Metalle, Schulden, Verbindlichkeiten
- Ausgaben und wiederkehrende Ausgaben
- Mitarbeiter, Aufgaben, Dokumente, Kundennachrichten
- Inventur/Stock-Check, Excel-Import, NBR-Export
- Medienverwaltung (Galerie, Ersetzen, Müllabfuhr)
- Lieferant anlegen — auch „+ New Supplier" in der Einkaufsmaske (keine Buchung `suppliers.create`; seit R5E FINAL
  eigens geführt, siehe dort)

> **Seit R6A (12.09.2026) ist die Tabelle „Write-Gap-SSOT“ im Abschnitt R6A die eine Quelle** für jede
> Schreibhandlung ohne gemeinsamen Weg. Die Liste hier bleibt als historischer Stand stehen.

Diese Seiten **zeigen** auf PC2 ihre Daten, ihre Schreibknöpfe laufen aber noch gegen die lokale
Datenbank und damit ins Leere. Das ist die nächste Ausbaustufe und ausdrücklich **noch nicht**
gelöst — siehe „Offen“.

## 6. Reine Primary-Funktionen

Datenort, Sicherung, Wiederherstellung, Server-Eigentum und -Konfiguration, Medien-Müllabfuhr,
Erstlauf/Provisionierung: maschinenbezogen. PC2 darf dafür **keine** lokale Autorität bekommen.
Diese Bereiche liegen in `SettingsPage`, die direkten Datenbankzugriff hat und deshalb ohnehin auf
der Ausreißerliste steht.

## 7. Offen (ehrlich benannt)

1. **Der echte PC2-Beweis fehlt noch.** Bewiesen ist bisher statisch und über die Gates
   (146/146 grün), nicht an zwei laufenden Anwendungen. `CENTRAL_UI_PARITY_REAL_PC2_CORE_UI_PROVED`
   ist damit **nicht** vergeben.
2. **Schreibwege der übrigen Seiten** (Abschnitt 5) laufen auf PC2 ins Leere statt einen klaren
   Zustand zu zeigen. Ein Knopf ohne Wirkung ist ausdrücklich unerwünscht.
3. **Zwei parametrisierte Ladewege** haben keine Auskunft: `orderPaymentStore.loadPayments(orderId)`
   und `customerMessageStore.loadMessages(customerId)`. Sie laden je einen Vorgang, nicht den Store.
4. **Filialname, Land und Währung** stehen nicht im Ausweis; die Sitzung trägt dort den
   Hausstandard, bis es eine Auskunft dafür gibt.
5. **Vier Seiten und zwei Komponenten** mit direktem Datenbankzugriff sind nicht paritätsfähig.
6. Der alte Befund bleibt: der Primary hat **keine Lese-Rechte-Tore**; die Store-Auskünfte stehen
   deshalb auf `null`. Ein Tor hier wäre eine erfundene Regel, kein Gleichstand.

---

## R1 — nebenwirkungsfreie Ladefunktionen und geprüfte Identität (08.09.2026)

Das Fundament oben hatte zwei Konstruktionsfehler, beide zuerst **rot bewiesen**
(`test/uiparity/r1-read-isolation.test.ts`, vier von sechs Zusagen fielen), dann behoben:

1. Die Fernauskunft rief die Ladefunktion des Primary-**Stores** — jedes Lesen von PC2 schrieb in
   den sichtbaren Zustand des Primary (Liste, Auswahl, Filter).
2. Diese Ladefunktion nahm ihre Filiale aus `currentBranchId()`, also aus der Sitzung des
   Primary. Ein Client aus Filiale B bekam die Daten von A — und ein Filialwunsch im Rumpf hätte
   es auch nicht besser gemacht.

**Der Schnitt jetzt:** `BusinessReadContext` (Mandant, Filiale, Benutzer, Rolle) reist als
Parameter. Am Primary kommt er aus der eigenen Sitzung, aus der Ferne **ausschließlich** aus dem
geprüften Absender (C4); der Client-Rumpf wird für die Identität gar nicht erst angesehen.
Die Ladefunktionen sind zustandsfrei und werden von **beiden** Wegen benutzt.

Migriert (repräsentativ, wie beauftragt): Artikel + Kategorien (branchabhängig), Kunden,
Rechnungen samt Zeilen, Auftragszahlungen (parametrisiert, Filiale im JOIN), sowie ein neuer
Sitzungskontext für Filialname, Land und Währung.

**Registry:** 1 Probe + 18 C2-Auskünfte + **5 typisierte Auskünfte** + 40 Buchungen = **64**.
Die 20 noch nicht umgestellten Stores sind aus der Registry **entfernt** und laufen auf PC2 in
einen ausdrücklichen Riegel (`remoteReadUnavailable`) — kein Datenbankzugriff, kein toter
Netzaufruf, eine Zeile im Protokoll. Nichts steht auf „läuft meistens".

**Offen bleibt:** die restlichen 20 Stores, die vier Seiten und zwei Komponenten mit direktem
Datenbankzugriff, die Schreibwege außerhalb der 40 Buchungen, die `Primary only`-Zustände in
der gemeinsamen Oberfläche — und der Beweis an zwei laufenden Anwendungen.

---

## R2A — die Kernflächen sind migriert (08.09.2026)

### Inventur der früheren 25 WIP-Auskünfte

| Stand | Anzahl |
|---|---|
| unsichere WIP-Auskünfte in `3eb7b81` | 25 |
| davon in R1 **entfernt** (unsicher: Store-Nebenwirkung + falsche Filiale) | 25 |
| in R1 sicher migriert | 3 (Artikel/Kategorien, Kunden, Rechnungen) + 2 neu (Auftragszahlungen, Sitzungskontext) |
| in R2A zusätzlich sicher migriert | 8 |
| **sicher insgesamt** | **13** |
| noch fern nicht verfügbar (fail-closed) | 14 Stores |

**Die Kategorien-Frage aus dem R1-Bericht:** es gibt keine eigene Kategorien-Auskunft und gab
auch nie eine. Kategorien und Artikel gehören zum selben Store und kommen gemeinsam über
`store.products.get` — in der WIP-Liste war das genauso. Es war also eine Benennungs-, keine
Abdeckungslücke.

### In R2A migrierte Domänen

Lieferanten (samt Ledger-Zahlen), Verkaufsretouren (samt Zeilen), Gutschriften, Aufträge,
Kommissionen, Einkäufe (samt Zeilen, Zahlungen, offenem Wareneingang und Retouren), Reparaturen
(samt Arbeitszeilen), Agenten und Agenten-Transfers.

Jede nach demselben Schnitt: eine exportierte, zustandsfreie `loadXFor(ctx)`-Funktion, vom
Primary-Store **und** vom Fernweg benutzt. Beim Lieferanten wurde dafür `getLedger` aus dem
Store-Objekt in die freie Funktion `supplierLedgerFor` gehoben — sie rechnete ohnehin nur aus
der Datenbank.

### Registry

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 13
Mutations        = 40
Total            = 72
```

TS und Rust stimmen bitgenau überein (`STORE_READ_OPS` ↔ `REMOTE_OPS`).

### Was fern weiterhin nicht verfügbar ist

- `bankingStore`
- `debtStore`
- `documentStore`
- `employeeStore`
- `expenseStore`
- `goldStore`
- `metalStore`
- `offerStore`
- `partnerStore`
- `payablesStore`
- `productionStore`
- `recurringExpenseStore`
- `scrapTradeStore`
- `taskStore`

Diese laufen auf PC2 in `remoteReadUnavailable`: kein Datenbankzugriff, kein Rückfall auf einen
Primary-Store-Loader, kein veralteter Zwischenspeicher. Das betrifft insbesondere Finanzen,
Berichte und Business Management — sie sind für R2B vorgesehen.

---

## R2B — der Rest der Lesefläche (08.09.2026)

### §1 Inventur der vierzehn fern gesperrten Stores

| Store | Ladefunktion(en) | Parameter | filialbezogen? | mandantenbezogen? | global/System? | direkte DB-Abhängigkeit | erwartete Verbraucher |
|---|---|---|---|---|---|---|---|
| `expenseStore` | `loadExpenses` | — | ja | über Filiale | nein | `expenses` | Ausgaben, Dashboard, Berichte, Lieferant, Auftrag, Reparatur, Kommission |
| `recurringExpenseStore` | `loadTemplates` | — | ja | über Filiale | nein | `recurring_expense_templates` | Ausgabenliste |
| `bankingStore` | `loadTransfers, getTransactions` | — | ja | über Filiale | nein | `bank_transfers + 14 Quell-Abfragen` | Bank, Dashboard |
| `payablesStore` | `loadPayables` | — | **nein → jetzt ja** | über Filiale | nein | `purchases, sales_returns, consignments, expenses, debts, settings` | Verbindlichkeiten, Dashboard |
| `debtStore` | `loadDebts, loadPaymentsForDebt` | debtId (Zahlungen) | ja | über Filiale | nein | `debts, debt_payments` | Darlehen, Kunde, Mitarbeiter, Forderungen, Berichte, Dashboard |
| `goldStore` | `loadAll → loadGoldPayables, loadCustomerGoldCredits` | — | ja | über Filiale | nein | `gold_payables, customer_gold_credits (+ 12 abgeleitete Abfragen)` | Reparatur, Kunde, Lieferant, Auftrag |
| `metalStore` | `loadMetals` | — | ja | über Filiale | nein | `precious_metals (+ Kurse, Zahlungen)` | Edelmetalle |
| `scrapTradeStore` | `loadTrades` | — | **nein → jetzt ja** | über Filiale | nein | `scrap_trades, _lines, _payments` | Altgold, Dashboard, Berichte |
| `employeeStore` | `loadEmployees` | — | ja | über Filiale | nein | `employees (+ 9 Verlaufsabfragen je Mitarbeiter)` | 15 Seiten/Komponenten (Personalauswahl überall) |
| `partnerStore` | `loadPartners, loadTransactions, getPartnerLedger` | partnerId (Saldo) | ja | über Filiale | nein | `partners, partner_transactions` | Gesellschafter, Dashboard, Berichte |
| `taskStore` | `loadTasks` | — | ja | über Filiale | nein | `tasks` | Aufgaben |
| `documentStore` | `loadDocuments` | — | ja | über Filiale | nein | `documents (Inhalt als Data-URL in `file_path`)` | Belege |
| `offerStore` | `loadOffers` | — | ja | über Filiale | nein | `offers, offer_lines` | Angebote, Rechnungsliste |
| `productionStore` | `loadRecords` | — | ja | über Filiale | nein | `production_records, _inputs, _outputs` | Fertigung |

**Der Befund der Inventur, und er war nicht erwartet:** zwei dieser Listen hatten überhaupt
keine Filialgrenze. `loadPayables` zählte Einkäufe, Retouren, Kommissionen, Ausgaben und
Darlehen **aller** Filialen zusammen, `loadTrades` ebenso alle Altgold-Geschäfte. Am
Ein-Filial-Betrieb fällt das nicht auf — als Fernauskunft wäre es die Preisgabe fremder Zahlen
gewesen. Beide sind jetzt auf den Ausweis der Anfrage eingeschränkt (fünf bzw. eine Abfrage).

### §1b Die sechs Stellen mit direktem Datenbankzugriff außerhalb der Stores

| Stelle | Einordnung | Auflösung |
|---|---|---|
| `pages/analytics/AnalyticsPage` | Geschäftsauskunft, rechnet in ~51 eigenen Abfragen | **eigener Schnitt nötig** — bis dahin ehrlicher Hinweis statt Nullen |
| `pages/settings/SettingsPage` | Maschine: Datenort, Sicherung, Aktualisierung, Wartung | `Primary only` |
| `pages/admin/RepairFlowTestPage` | Maschine: Entwicklerwerkzeug, schreibt Testfälle | `Primary only` |
| `pages/auth/OnboardingPage` | Maschine: Erstlauf einer neuen Datenbank | bereits unerreichbar (`!clientMode && needsOnboarding`) |
| `components/sync/SyncDuplicateGuard` | Maschine: hängt am Abgleich | untätig — das Ereignis kommt nur aus `sync-service`, und der ist im Client verweigert |
| `components/products/StockCheckInventoryModal` | **Geschäfts-SCHREIBvorgang** (Inventursitzung) | **Lücke** — Schreiben bleibt bei den 40 Buchungen, diese ist keine davon |

Als siebte Stelle taucht `components/shared/UpdateBanner` im Rohbefund auf; sie ruft nur
`saveDatabaseDurably`, und das kehrt ohne Datenbank sofort zurück. Keine Auflösung nötig.

### §2–§4 Migrierte Domänen

**Finanzen:** Ausgaben, Daueraufträge, Bank (Umbuchungen **und** die abgeleitete Bewegungsliste),
Verbindlichkeiten, Darlehen, Gold (Verbindlichkeiten + Kundenguthaben), Edelmetalle,
Altgold-Geschäfte.

**Betriebsführung:** Mitarbeiter, Gesellschafter (samt Salden), Aufgaben, Belege, Angebote,
Fertigung.

**Berichte und Auswertungen** brauchten keine eigene Auskunft: `BusinessReportsPage` und
`ReceivablesPage` rechnen ausschließlich aus Stores. Mit deren Migration sind sie
paritätsfähig, ohne dass eine Zeile an ihnen geändert wurde. Der Scope-Audit dieser Flächen
sagt dasselbe wie die Loader: Zeitraum, Kategorie, Status und Gruppierung sind **Auswahl** und
stehen in der Seite; Filiale und Mandant sind **Berechtigung** und kommen aus dem Ausweis.
Keine dieser Seiten ersetzt das eine durch das andere.

### Drei Entscheidungen, die im Code sichtbar sind

1. **Die Bank rechnet weiter auf Abruf.** `getTransactions` kostet gut ein Dutzend Abfragen.
   Sie in die Ladefunktion zu ziehen hätte das Dashboard verteuert. Am Primary bleibt es
   deshalb beim Abruf; die Fernauskunft schickt die fertige Liste mit, weil drüben keine
   Datenbank steht, aus der man sie nachrechnen könnte.
2. **Der Altgold-Nachtrag bleibt am Primary.** `loadTrades` rief `backfillTradeData()` —
   einen SCHREIBvorgang. Eine Auskunft liest; sie repariert nicht. Der Nachtrag steht jetzt im
   Store, nicht in der gemeinsamen Ladefunktion, und ein Test hält das fest.
3. **Belege reisen ohne Inhalt.** In `documents.file_path` steht nicht ein Pfad, sondern die
   ganze Datei als Data-URL. Die Ladefunktion kann den Inhalt abwählen: der Primary liest wie
   bisher alles, die Fernauskunft schickt nur die Liste. Die Belegliste prüft `filePath` ohnehin
   schon und zeigt dann ihr Symbol.

### Registry

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 27   (13 aus R1/R2A + 14 aus R2B)
Mutations        = 40   (unverändert — R2B fasst keinen Schreibweg an)
Total            = 86
```

TS und Rust stimmen bitgenau überein (`STORE_READ_OPS` ↔ `REMOTE_OPS`).

### Was auf einem Rechner ohne Datenbank weiterhin nicht geht

- **Auswertung** (`/analytics`) — eigener Schnitt, eigene Scheibe. Zeigt einen Hinweis, keine Nullen.
- **Einstellungen, Entwicklerwerkzeug** — Maschinenfunktionen, `Primary only`.
- **Inventursitzung** — ein Schreibweg, der nicht zu den 40 Buchungen gehört.
- **Einzelne abgeleitete Detailabfragen**, die synchron aus der Datenbank rechnen statt aus dem
  Bestand: `expenseStore.getExpensePayments`, `debtStore.loadPaymentsForDebt`,
  `metalStore.getSpotPrice/getMetalPayments`, die zwölf Auswertungen in `goldStore`,
  die neun Verlaufslisten in `employeeStore`. Sie liefern dort leere Mengen — die Listen,
  an denen sie hängen, kommen vollständig an.
- **Kundennachrichten** (`customerMessageStore`) — eine Liste je Kunde, ohne Filialbezug und
  ohne Riegel; sie faengt ihren Fehler ab und bleibt auf einem Client leer. Fern ist sie gar nicht
  erreichbar, weil es fuer sie keinen Namen in der Registry gibt.

---

## R2C — Auswertung, Beleginhalt, und der ehrliche Schlussstand (08.09.2026)

### §1 Die zwei Scope-Fehler sind festgenagelt

`test/uiparity/r2c-payables-trades-scope.test.ts` (32/0) prüft für **jede** der sechs
korrigierten Abfragen: Filiale A sieht ihre Zeile, Filiale B sieht sie nicht, die Sitzung des
Menschen am Primary (absichtlich eine **dritte** Filiale) ändert nichts, und ein Filialwunsch im
Rumpf ändert nichts. Die Negativkontrolle zählt dieselben Abfragen **ohne** Prädikat: sie liefern
mehr Zeilen, als der Anfragende besitzen darf — der Fehler war real.

**Dabei gefunden und behoben:** die Karenzfrist las `parseInt(…) || 30`. Eine eingestellte
Karenz von **null** Tagen ist gültig („fällig am Rechnungsdatum") und wurde davon still auf
dreißig zurückgedreht. Jetzt greift der Rückfall nur noch, wenn gar nichts Lesbares dasteht.

### §2 Die Auswertung, wirklich gezählt

| Block | Abfragen | Quellen (Auszug) | Parameter | Filialgrenze heute |
|---|---|---|---|---|
| Verkauf | 5 | `invoices, offers, invoice_lines, products, categories` | — | in jeder |
| Bestand | 4 | `products, categories` | — | in jeder |
| Finanzen | 33 | `invoices, purchases, repairs, consignments, scrap_trades, payments, expenses, debts, settings, bank_transfers, partner_transactions, tax_payments …` | — | in jeder |
| Kunden | 7 | `customers, invoices, invoice_lines` | — | in jeder |
| Hilfsrechnung | 1 | `sales_returns, invoices` | — | ja |

**Befund des Audits:** 50 echte Abfragen, und **alle 50** trugen bereits `branch_id = ?`.
Hier gab es also keinen zweiten Leak wie bei den Verbindlichkeiten. Ebenso wichtig: diese
Fläche hat **keine** Zeitraum-, Kategorie- oder Statusauswahl — die vier Blöcke hängen allein
an der Filiale (`useMemo(…, [branchId])`). Es gab also nichts zu trennen; käme später ein
Filter dazu, wäre er ein Parameter und niemals die Berechtigung.

### §3/§4 Eine gemeinsame Rechnung, ein Netzvertrag

`src/core/reports/analytics-snapshot.ts` hält jetzt die vollständige Rechnung:
`salesFor(ctx)`, `stockFor(ctx)`, `financeFor(ctx)`, `clientsFor(ctx)` und darüber
`loadAnalyticsFor(ctx) → { snapshot }`. Zustandsfrei, ohne `currentBranchId()`, ohne React.
Die Seite hat keine eigene Abfrage mehr; sie liest vier Felder aus `useAnalyticsStore`.

Über das Netz ist das **eine** Auskunft (`store.analytics.get`) statt fünfzig Aufrufen — und
als Nebeneffekt stammen alle Zahlen garantiert aus demselben Augenblick. Der Steuerbericht
ist bewusst **nicht** Teil davon: er ist zeilenweise und reist nur auf Knopfdruck
(`analytics.vat_export.get`).

### §5 Die Zahlen stimmen — gegen die Fixture gerechnet

Zwei Filialen mit verschiedenen Zahlen, der Primary in einer dritten. Geprüft gegen von Hand
gerechnete Erwartungen: Verkauf (1 Rechnung / 200 gegen 1 / 500), Bestand (1 Stück 100/150
gegen 2 Stück 14/18), Einkauf (5 Vorsteuer gegen 0), Forderungen (eine offene über 60 gegen
keine) und Verbindlichkeiten (ein Einkauf über 55 gegen keinen).

### §6 Der Beleginhalt

Die Belegliste zeigt Vorschaubilder aus `documents.file_path` — dort steht die **ganze Datei**
als Data-URL. Der Inhalt bleibt deshalb aus der Liste (R2B) und kommt über einen eigenen,
ausdrücklichen Weg: `documents.content.get(documentId)`. Kennung genannt, Filiale aus dem
Ausweis, fremder Beleg = **nicht da** (nicht „verboten" — die Antwort verrät nicht einmal seine
Existenz), kein Pfad vom Client, und ein alter **echter Dateipfad** im Feld wird nicht als
Inhalt ausgeliefert. Dieselbe Vorschau öffnet auf beiden Rechnern; die Liste zeigt auf einem
Client ihr Symbol, bis jemand einen Beleg wirklich öffnet.

### §7 Der vollständige Scan — und was er zutage brachte

**Die bisherige Zählung war zu klein.** „Vier Seiten, zwei Komponenten" entstand aus der Suche
nach dem Import von `core/db/database` und übersah damit jede Seite, die einfach `query` aus
`core/db/helpers` holt. Der neue Scan (`test/uiparity/r2c-direct-db-scan.test.ts`) sucht nach
dem Zugriff selbst und ordnet **jede** Fundstelle ein:

| Art | Stellen | Auflösung |
|---|---|---|
| Maschine | 6 | `Primary only` an der Route (Einstellungen, Entwicklerwerkzeug, Abstimmung, Nachbuchung, Hauptbuch-Rohsicht) + Erstlauf unerreichbar |
| untätig | 1 | `SyncDuplicateGuard` — sein Ereignis kommt nur aus dem im Client verweigerten Abgleich |
| Schreiblücke | 2 | Inventursitzung; Steuerzahlung eintragen (Schaltfläche im Client ausgeblendet) |
| **offen (Lesen)** | **12** | **brauchen auf PC2 noch eine lokale Datenbank** |

Die zwölf offenen Lesestellen, namentlich und gezählt (41 Zugriffe):

- `pages/watches/ProductDetail` (8) — Verkaufs-, Einkaufs- und Fertigungshistorie eines Artikels
- `components/shared/GlobalSearch` (9) — die übergreifende Suche
- `pages/suppliers/SupplierDetail` (5) — Zahlungen, Retouren, Ausgaben
- `pages/customers/CustomerDetail` (3) — Zahlungen, Erstattungen, Gutschriften
- `pages/orders/OrderDetail` (3) — Einkaufsverknüpfung, Zahlungstopf, vereinbarter Preis
- `pages/purchases/PurchaseCreate` (3) — Wareneingang und Auftragszeilen als Vorlage
- `components/expenses/PaySupplierModal` (3) — Belegnummern verknüpfter Vorgänge
- `pages/invoices/InvoiceList` (2) — Zahlungen und Zahl der offenen Rechnungen
- `pages/watches/WatchList` (2) — Mandant der Filiale
- `pages/dashboard/Dashboard` (1) — Monatsziel aus den Einstellungen
- `pages/orders/OrderList` (1) — Summe der Anzahlungen je Auftrag
- `components/repairs/SettleGoldModal` (1) — Goldbestand je Karat

Das Gate ist heute **grün** und hält diesen Stand fest: eine neue, nicht eingeordnete Stelle
macht es rot, und die Zahlen dürfen nur sinken. Der Marker
`CENTRAL_UI_PARITY_FULL_READ_SURFACE_PROVED` wird **nicht** vergeben, solange diese zwölf
stehen — sie sind die Arbeit von R2D.

### §8/§9 Isolation und Registry

Auswertung, Steuerbericht und Beleginhalt fassen keinen Primary-Bestand an (Sentinel vorher/
nachher, ohne Sichern und Zurückspielen); insbesondere landet die Auswertung des Anfragenden
nicht im Bestand des Primary.

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 30   (27 aus R1/R2A/R2B + 3 aus R2C)
Mutations        = 40   (unverändert)
Total            = 89
```

**Zur Typprüfung:** `npx tsc --noEmit` auf der Wurzel prüft **nichts** — `tsconfig.json` ist
eine reine Verweisdatei (`"files": []`). Das echte Tor ist `tsc -b` bzw.
`tsc --noEmit -p tsconfig.app.json`; frühere Meldungen „tsc sauber" aus der Wurzel waren
inhaltsleer. Beide Projekte sind jetzt geprüft und sauber.

---

## R2D — die Lesefläche ist geschlossen (08.09.2026)

### §1/§10 Der Scan als einzige Wahrheit

| Art | vor R2D | nach R2D |
|---|---|---|
| Maschine (`Primary only`) | 6 | **4** |
| untätig | 1 | 1 |
| Schreiblücke | 2 | **4** |
| **offenes Geschäftslesen** | **12 Dateien / 41 Zugriffe** | **0** |

Damit ist die Zusage einlösbar: **keine Fläche der gemeinsamen Oberfläche liest noch aus einer
lokalen Datenbank.** Das Gate `test/uiparity/r2c-direct-db-scan.test.ts` hält den Stand fest und
wird rot, sobald eine neue, nicht eingeordnete Stelle dazukommt.

### §2 Neu klassifiziert — nach Autorität, nicht nach Bauweise

| Fläche | was der Mensch dort tut | Einordnung |
|---|---|---|
| **Abstimmung** (`/reconciliation`) | vergleicht Hauptbuch mit den Fachaggregaten | **buchhalterische Auskunft → jetzt fern lesbar.** Nur der Storno bleibt am Hauptrechner, und die Schaltfläche erscheint dort nicht, wo sie nichts täte. |
| **Nachbuchung** (`/ledger-backfill`) | schreibt fehlende Hauptbuchzeilen nach | Geschäfts-**Schreiben** → Lücke, dokumentiert, `Primary only` |
| **Hauptbuch-Rohsicht** (`/ledger-debug`) | erzeugt Testbuchungen im Hauptbuch | Prüfstand, der **schreibt** → machine-local |
| Einstellungen | Datenort, Sicherung, Aktualisierung, Benutzer | machine-local; die fachlichen Teile sind Schreibmasken |
| Entwicklerwerkzeug, Erstlauf | Testfälle schreiben, neue Datenbank anlegen | machine-local |

### §3/§4 Zwölf Flächen, zwölf typisierte Auskünfte

Aus 41 direkten Zugriffen wurden **zwölf** Namen — einer je Fläche oder Domäne, keiner je Abfrage:

```
page.dashboard.get         page.customer_detail.get   refs.numbers.get
page.invoice_list.get      page.order_detail.get      metals.stock_by_karat.get
page.order_list.get        page.supplier_detail.get   search.global.get
page.product_detail.get    page.purchase_create.get   page.reconciliation.get
```

Die Ladefunktionen liegen in `src/core/data/page-reads.ts`, `src/core/search/global-search.ts` und
`src/core/reports/reconciliation-snapshot.ts`. Die Seiten benutzen sie über **eine** Zeile:

```ts
const x = useSharedRead('page.foo.get', { id }, (ctx) => fooFor(ctx, id), LEER, [deps]);
```

Am Primary rechnet das synchron und gemerkt wie das frühere `useMemo`; auf einem Client fragt es
einmal nach. Keine Seite weiß, an welchem Rechner sie läuft.

**Der Mandant** kam dreimal aus `SELECT tenant_id FROM branches`. Dafür braucht es keine Auskunft:
am Primary steht er in der Filialtabelle, auf einem Client im geprüften Ausweis — `sessionTenantId()`.

### §5/§6 Was die Prüfung erzwingt

Drei Filialen mit vollem Belegsatz, der Mensch am Primary in der **dritten**. Für jede der zwölf
Auskünfte: A bekommt A, B bekommt von A **nichts** (und sehr wohl das Eigene), die Sitzung am
Primary ändert nichts, ein Filialwunsch im Rumpf ändert nichts. Eine Kennung ist **Auswahl**:
ein fremder Artikel hat keine Historie, ein fremder Kunde keine Zahlungen, eine fremde Vorlage
füllt kein Formular. Ohne Kennung gibt es keine Antwort.

### Drei echte Defekte, von der Migration ans Licht gebracht

1. **Die übergreifende Suche war kaputt — und sagte es nicht.** Zwei Abfragen nannten Spalten,
   die es in dieser Datenbank nie gab (`products.retail_price`, `purchases.gross_amount`).
   Ein einziger umschließender `try` verschluckte den Fehler; weil die Artikelabfrage früh
   stand, fiel mit ihr **alles danach im selben Block** aus — Kunden, Angebote, Rechnungen,
   Reparaturen, Aufträge. Die Suche fand still nichts. Beide Spalten sind korrigiert
   (`planned_sale_price`, `total_amount`), und das Gate prüft jetzt zusätzlich das
   **Protokoll**: eine geschluckte Abfrage ist ein Fehlschlag, kein leeres Ergebnis.
2. **Die Rechnungsliste zählte über alle Filialen.** Weder die Zahlungen noch die Zahl der
   offenen Rechnungen hatten eine Filialgrenze.
3. **Die Auftragsliste ebenso**: die Summe der Anzahlungen lief über alle `order_payments`.

### Registry

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 42   (30 aus R1–R2C + 12 aus R2D)
Mutations        = 40   (unverändert seit C3)
Total            = 101
```

TS und Rust bitgenau gleich. Geprüft mit `tsc --noEmit -p tsconfig.app.json` **und**
`-p tsconfig.node.json` — die Wurzel prüft nichts.

### Was auf einem Rechner ohne Datenbank weiterhin nicht geht

Nur noch **Schreiben**, und zwar viermal: die Inventursitzung, das Eintragen einer Steuerzahlung,
die Umwandlung Auftrag→Rechnung (sie rechnet den Zahlungstopf lokal um) und die Nachbuchung im
Hauptbuch. Keine dieser Schaltflächen wird auf einem Client angeboten. Dazu die vier
Maschinenflächen, die sagen, wo sie zu bedienen sind.

---

## R3 — zwei echte Anwendungen, und was dabei herauskam (08.09.2026) · **BLOCKED**

### §1/§2 Die Schreibfähigkeiten, abgeglichen

Die vierzig geprüften Fernbuchungen sind vollständig gebaut — TS und Rust, Rechte, Ledger,
Exactly-once. Der Abgleich mit der **laufenden** Oberfläche ergibt trotzdem:

```
Fernbuchungen insgesamt                              40
davon von der ALTEN ClientShell erreichbar (vorher)  38
davon von der GEMEINSAMEN Oberflaeche erreichbar      0
```

**Das ist kein Konstruktionsstand, sondern ein Verlust.** Bis zur Parität war `ClientShell` die
Oberfläche des Clients und rief die Buchungen über den Speichervertrag auf. Seit der Parität
führt sie nur noch zum Server und meldet an; danach läuft dieselbe Anwendung wie am Primary —
und deren Stores schreiben synchron in die **lokale** Datenbank, die es auf PC2 nicht gibt.

**Zur Pflichtprüfung `orders.convert_to_invoice`:** die Buchung existiert, aber sie ist **enger**
als die Handlung der Oberfläche. Sie legt die Rechnung an und verknüpft die Zeilen; die
Auftragsseite trägt danach den Anzahlungstopf über und teilt eine Überzahlung ab
(`carryOverOrderPaymentsToInvoice`). Wer nur die Buchung aufruft, lässt Geld liegen. Deshalb
wird sie **nicht** einfach verdrahtet — dieselbe Kennung mit zwei verschiedenen Wirkungen wäre
schlimmer als eine ehrliche Lücke. Festgehalten in `test/uiparity/r3-write-matrix.test.ts`.

### §3 Der echte Zwei-App-Lauf — was er bewiesen hat

Zwei wirkliche Anwendungen (`com.lataif.app.e2e` / `.client`), **ohne** localStorage-Kniff:
der Client startet leer, zeigt seine Erstlauf-Maske, ein Klick auf „Connect to existing LATAIF
server", die Adresse, die Anmeldung — und danach steht die normale Anwendung mit **derselben
Seitenleiste, Ziel für Ziel**. Der Modus stand danach auf `client`, gesetzt vom Knopf.

### §3 …und woran er scheitert

**Die gemeinsame Oberfläche stürzt auf einem echten Client ab:** `Error: Database not
initialized`. Die Fehlergrenze fängt es ab und bleibt danach im Fehlerzustand — **jede weitere
Seite sieht dann leer aus**, ohne dass irgendwo etwas rot wird. Genau deshalb prüft das Gate
jetzt als Erstes darauf.

**Warum der R2D-Scan das nicht sah:** er zählte `query(` und `getDatabase(` **in Seiten und
Komponenten**. Eine Seite kann die Datenbank aber auch **durch eine Kernfunktion** lesen —
Hauptbuch-Salden, Forderungsaufstellung, Los-Abfragen. Die Übersicht tut genau das. Das Modell
des Scans war zu eng; die Lesefläche ist damit **nicht** vollständig geschlossen, sondern nur
auf der Ebene der Seiten selbst.

### Der Stand nach R3

| § | Sache | Stand |
|---|---|---|
| §1 | Schreibmatrix gegen die 40 | **belegt** — 0 von 40 erreichbar |
| §2 | echte Lücken benannt | **belegt** — inklusive der Enge von `orders.convert_to_invoice` |
| §3 | Verbinden ohne Kniff, gleiche Seitenleiste | **belegt** |
| §3 | dieselben Seiten mit Inhalt | **rot** — Absturz aus einer Kernfunktion |
| §4 | dieselben Zahlen | **rot** — Folge des Absturzes |
| §5 | Primary-Bildschirm unberührt | belegt, aber schwach (der Client zeigte nichts) |
| §6 | Schreibweg über die gemeinsame Oberfläche | **fehlt** |
| §7 | kein Geschäftsspeicher auf dem Client | **belegt** |
| §8 | Maschinenflächen sagen es | **rot** — Folge des Absturzes |

### Was als Nächstes zu tun ist (R4)

1. **Den Absturz beseitigen:** die Kernfunktionen, die eine Seite beim Zeichnen befragt
   (Hauptbuch, Forderungen, Lose), brauchen denselben Schnitt wie die Store-Ladefunktionen.
   Der Direkt-Scan muss dann über den Aufrufweg gehen, nicht über die Datei.
2. **Den Schreibweg bauen:** ein Gegenstück zu `hydrateFromPrimary` für Buchungen, auf
   `CommandSaveController` (Exactly-once ist dort schon gelöst). Die Store-Aktionen sind heute
   **synchron** — das ist die eigentliche Entwurfsfrage, und sie gehört in eine eigene Scheibe.
3. Erst danach ist `orders.convert_to_invoice` sinnvoll zu verdrahten — zusammen mit dem
   Anzahlungsübertrag, sonst bleibt es die engere Handlung.

### Nebenbei behoben

**Der Client blieb nach dem Anmelden weiß.** `authStore.initialize()` rief `getUserBranches()`,
das `user_branches` liest — eine Tabelle, die es ohne Datenbank nicht gibt. Der Fehler flog
während des Aufbaus, also vor jeder Fehlergrenze. Jetzt fällt die Filialliste auf die Filiale
des geprüften Ausweises zurück: es ist genau eine, und mehr darf dieser Rechner ohnehin nicht
sehen.

---

## R4A — die Lesefläche, jetzt am laufenden Programm gemessen (08.09.2026)

### Warum es einen neuen Maßstab brauchte

R2D hat die Abfragen aus den Seiten geholt und danach gezählt, was noch **in** Seiten steht. Der
erste Lauf an zwei echten Rechnern hat gezeigt, dass diese Zählung am Kern vorbeigeht: eine
Seite liest auch, wenn sie `balanceOf`, `receivablesBreakdown`, `getStockAggregates` oder
`creditPaidByExpense` ruft. Ein Scan über Dateien kann das nicht beweisen — **gefahren** werden
muss es.

### §1/§2 Der reproduzierte Absturz und der neue Maßstab

Der Weg, wörtlich: frischer Rechner → „Connect to existing LATAIF server" → Anmeldung → normale
Anwendung → Übersicht → `Error: Database not initialized`. Und der Teil, der es gefährlich
machte: **die Fehlergrenze bleibt danach im Fehlerzustand**. Ohne frischen Seitenaufbau je Route
sieht jede weitere Fläche einfach leer aus, ohne dass irgendwo etwas rot wird.

Der neue Maßstab ist deshalb `test/e2e/r4a-route-crawl.e2e.mjs`:

- zwei echte Anwendungen, echter Verbindungsklick, echte Anmeldung,
- **jede Route mit eigenem Seitenaufbau**,
- ein Stolperdraht, der über `Page.addScriptToEvaluateOnNewDocument` **vor** dem ersten Skript
  der Seite liegt und jeden Griff zur lokalen Datenbank mit Route, Meldung und Bauteil festhält.

Der Stolperdraht lebt im Test. Im ausgelieferten Programm gibt es keinen Debug-Zugang.

### §3 Die transitive Inventur

| Kernfunktion | Modul | wer rief sie beim Zeichnen |
|---|---|---|
| `balanceOf`, `totalReceivables` | `ledger/queries` | Übersicht, Bank |
| `receivablesBreakdown` | `finance/receivables` | Übersicht, Forderungen, Berichte |
| `getStockAggregates`, `deriveProductCostFromLots`, `getLotsWithPurchaseNumbers` | `lots/lot-queries` | Sammlung, Artikel, Rechnung/Auftrag anlegen, Angebote |
| `creditPaidByExpense`, `creditPaidForExpense` | `finance/expenseSettlement` | Ausgaben, Auftrag, Lieferant, Reparatur, beide Zahlmasken |
| `getStockValue`, `getStockByCategory` | `stores/productStore` | Übersicht |

Fünf neue **Domänen**-Auskünfte decken das ab — ein Name je Sache, nicht je Bildschirm:

```
ledger.balances.get           finance.receivables.get
inventory.lot_aggregates.get  product.lots.get
expenses.credit_paid.get
```

Kopiert wurde nichts: `core/data/domain-reads.ts` **ruft** die vorhandenen Funktionen auf. Die
reinen Rechnungen bleiben, wo sie sind — `computeExpenseSettlement`, `summarizeInventory`,
`bucketTotals`, `formatLotLabel` brauchen keine Datenbank und wurden nicht angefasst.

### Vier echte Defekte, die dabei ans Licht kamen

1. **Der Client blieb nach dem Anmelden weiß** (schon in R3 gefunden, hier bewiesen):
   `getUserBranches()` las `user_branches` — im Aufbau, also vor jeder Fehlergrenze.
2. **Der Medien-Nachlauf lief auch ohne Datenbank.** `triggerMediaRecoveryPostAuth` stieß
   Wiederherstellung, Einbettungen und den Telefon-Posteingang an; auf einem Client endete das
   bei **jedem** Seitenaufbau in abgewiesenen Zusagen. Er gehört zur Maschine und startet dort
   nicht mehr.
3. **Einkauf-Detail zählte Haken falsch** (React #310): die „nicht gefunden"-Weiche stand VOR
   einem `useMemo`. Am Primary fiel es kaum auf, weil der Einkauf beim ersten Zeichnen meist
   schon da war; auf einem Client kommt er erst mit der Antwort — erster Aufbau kurz, zweiter
   lang. Die Weiche steht jetzt hinter allen Haken.
4. **Die Bankseite zeigte drei Nullen.** Ihr `catch` fing den Fehler ab und lieferte
   `{cash:0, bank:0, benefit:0}` — Zahlen, die wie Salden aussehen und keine sind.

Dazu ein weiterer Scope-Fund derselben Sorte wie in R2B: `receivablesBreakdown()` hatte
**keine Filialgrenze** und zählte Kommissionen, Rechnungen, Übergaben und Reparaturen aller
Filialen zusammen. Sie nimmt jetzt eine Filiale entgegen und gibt sie an alle vier Quellen weiter.

### §5–§9 Ergebnis am laufenden Programm

```
38 Geschaeftsflaechen   → alle gezeichnet, kein Absturz, kein Zugriff auf eine lokale Datenbank
 4 Maschinenflaechen    → zeigen ihren Hinweis, stuerzen nicht ab
 0 offene Lesestellen
```

Dazu: die Identität des Clients stammt aus dem geprüften Ausweis (Filiale der Sitzung == Filiale
im Ausweis == Filiale des Datenbestands), der Bildschirm des Primary ist nach dem gesamten
Rundgang unverändert, und auf dem Client liegt weiterhin keine `lataif.db`, kein Datenort,
kein Ausgangskorb.

### Registry

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 47   (42 aus R1–R2D + 5 Kernauskuenfte aus R4A)
Mutations        = 40   (unveraendert — R4A fasst keinen Schreibweg an)
Total            = 106
```

### Was R4A ausdrücklich NICHT anfasst

Die gemeinsame Oberfläche erreicht weiterhin **0 von 40** Fernbuchungen (R3 §1). Das bleibt
offen und ist die nächste Scheibe. Ebenso zwei Leseaufrufe, die erst auf **Klick** laufen
(Losauswahl in „Rechnung anlegen" und „Reparatur anlegen") sowie der Verlauf-Aufklapper und die
eigenen Landesvorwahlen — sie gehören zu Handlungen, nicht zum Zeichnen, und sind im Gate
namentlich eingeordnet.

---

## R4A.1 — die zwei Lesevorgänge, die erst auf Klick laufen (09.09.2026)

### Was offen war

R4A hat jede Fläche gezeichnet und dabei zwei Stellen bewusst stehen lassen: sie laufen beim
Zeichnen nie, sondern erst, wenn der Mensch einen Artikel gewählt hat. Ein Rundgang erreicht
sie deshalb nicht — er klickt nicht.

### §1 Die beiden Wege, Klick für Klick

```
/invoices/new (InvoiceCreate)
  → Klick in den Artikel-Picker einer Zeile
  → pickProductForLine(idx, productId)
  → Neuzeichnen: computed = lines.map(...)
  → FRUEHER: getLotsWithPurchaseNumbers(product.id)
  → core/lots/lot-queries.ts  →  query(SELECT ... FROM stock_lots ...)  →  getDatabase()
  → JETZT:   useSharedRead(product.lots.batch.get, { productIds })

/repairs (RepairList, Maske „New repair")
  → Klick in den Artikel-Picker („Own Item")
  → setForm({ productId })
  → Neuzeichnen: der Block unter dem Picker
  → FRUEHER: getLotsWithPurchaseNumbers(form.productId!)
  → dieselbe Abfrage, dieselbe Datenbank
  → JETZT:   useSharedRead(product.lots.get, { productId })
```

Zwei Griffe, nicht einer: „Rechnung anlegen" fragte die Datenbank ZUSÄTZLICH im Klick selbst,
um sofort das älteste Los vorzuwählen. Das ist jetzt weg — der Klick setzt nur noch den
Zustand, und die FIFO-Wahl fällt beim Zeichnen (`lots.find(...) || lots[0]`), also genau
dort, wo sie ohnehin schon fiel. Gespeichert wird derselbe Lot wie vorher.

### §3 Wiederverwendet, nicht neu erfunden

„Reparatur anlegen" fragt nach EINEM Artikel und nimmt deshalb die vorhandene Auskunft
`product.lots.get`. „Rechnung anlegen" braucht die Lose ALLER Zeilen gleichzeitig — ein
Aufruf je Zeile wäre ein Rundgang je Zeile. Dafür, und nur dafür, kam eine kleine neue
Auskunft dazu: `product.lots.batch.get`. Sie ruft dieselbe Einzelauskunft in einer
Schleife; die FIFO-Logik ist nicht kopiert.

### Ein echter Scope-Fund derselben Sorte wie in R2B/R4A

`productLotsFor` hatte ein `void ctx`: die Lose hingen am Artikel, nicht an der Filiale.
Über das Netz hieß das — eine fremde Artikelkennung genügte, und der Client bekam die Lose
einer fremden Filiale samt Einkaufsnummer, Lieferant und Einstandspreis. `stock_lots` hat
eine `branch_id`; sie wurde nur nicht gelesen.

`getLotsWithPurchaseNumbers()` und `deriveProductCostFromLots()` nehmen jetzt eine Filiale
entgegen (`AND sl.branch_id = ?`), und die Auskunft gibt ihnen die des AUSWEISES weiter —
derselbe Schnitt wie bei `receivablesBreakdown()` in R4A. Die Negativkontrolle im Gate stellt
den alten Zustand nach: dieselbe Abfrage ohne Filialgrenze liefert die fremden Lose.

### Nebenbefund im Prüfstand selbst

`r2c-payables-trades-scope.test.ts` rechnete die Fälligkeit gegen die ECHTE Uhr, baute den
Fall aber auf einem fest eingetragenen Tag auf. Das Gate wanderte damit jeden Kalendertag um
eins weiter (40 → 41 → …) und wäre ohne jede Programmänderung rot geworden. Der Aufbau nimmt
jetzt dieselbe Uhr wie die Anwendung.

### §2/§5/§6 Am laufenden Programm

```
test/uiparity/r4a1-click-reads.test.ts   31/0   Weg, Wiederverwendung, Autoritaet, Negativkontrolle
test/e2e/r4a1-click-reads.e2e.mjs               zwei echte Anwendungen, zwei echte Klicks
test/e2e/r4a-route-crawl.e2e.mjs          9/0   der Rundgang bleibt gruen
```

Der E2E-Lauf klickt wirklich: Artikel-Picker auf, Artikel wählen, und die Losauswahl muss
offen dastehen — beide Lose, beide echten Einstandspreise, die Einkaufsnummer aus der
verbundenen Tabelle, FIFO vorgewählt. Dabei kein Griff zur lokalen Datenbank, keine
Fehlergrenze; der Bildschirm des Primary (Route, Suche, Auswahl, geöffnete Ansicht) ist
danach unverändert, und auf dem Client liegt weiterhin kein Geschäftsspeicher.

### Registry

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 48   (47 aus R1–R4A + 1 Sammelauskunft aus R4A.1)
Mutations        = 40   (unveraendert — R4A.1 fasst keinen Schreibweg an)
Total            = 107
```

---

## R4B — die gemeinsame Oberfläche kann schreiben (09.09.2026)

### Der Befund, den R3 gemacht hat

Die gemeinsame Oberfläche erreichte **0 von 40** geprüften Fernbuchungen. Nicht, weil die
Buchungen fehlten — es gab sie alle —, sondern weil jede Schreibaktion direkt die Store-Aktion
rief, und die holt als erstes `getDatabase()`. Am Hauptrechner richtig, auf einem zweiten
Rechner ein Fehler mitten im Klick.

### §1 Die Wege, Klick für Klick

```
VORHER (jede Schreibaktion, ohne Ausnahme)
  Klick → Seite → Store-Aktion → getDatabase() → db.run(...)

DANEBEN, seit C3 vorhanden und ungenutzt
  op → /api/command → Bruecke → Primary-Domaenenfunktion → eine Transaktion + Kennungsnachweis

JETZT
  Klick → Seite → useSharedWrite(op).save({ local, remote })
                     ├─ Primary: dieselbe vorhandene Domaenenfunktion (synchron)
                     └─ Client:  dieselbe vorhandene geprueste Fernbuchung
```

| UI-Handlung | lokale Funktion | Fernbuchung | Rückgabe | Fehlerart | Kennung/Fassung |
|---|---|---|---|---|---|
| Kunde anlegen | `createCustomer(data): Customer` | `customers.create` | `{customerId,name}` | `CUSTOMER_PAYLOAD_INVALID` | Kennung je Vorsatz |
| Kunde ändern | `updateCustomer(id, data): void` | `customers.update` | `{customerId,name}` | `CUSTOMER_NOT_FOUND` | Kennung je Vorsatz |
| Artikel ändern (Text) | `editProductTextDurably(...)` | `products.update` | `{status}` | Preissperre, `PRODUCT_NOT_FOUND` | Kennung je Vorsatz |
| Rechnung anlegen | `createDirectInvoice(...)` | `invoices.create` | `{invoiceId,invoiceNumber,...}` | Bestand, Steuer, Nummernkreis | Kennung je Vorsatz |

### §2 Was die Weiche NICHT ist

`core/data/shared-write.ts` enthält keine einzige Geschäftsregel: keine Steuer, keinen
Bestand, keinen Nummernkreis, keine Buchung, keine Fassungszählung, keine Validierung, keine
Medienlogik. Sie kennt zwei Anschlüsse und vier Ausgänge, sonst nichts. Das Gate prüft das
wörtlich (kein `SELECT`, kein `getDatabase`, keine Steuerbegriffe im Modul).

Die Feldlisten (was ein Rumpf mitbringen darf) standen bisher nur im Fernbefehl. Sie wohnen
jetzt in `core/data/write-payloads.ts`, und **der Befehl liest sie von dort** — eine Liste,
zwei Leser. Eine zweite Liste wäre ein zweiter Vertrag, der auseinanderläuft.

### §3 Die asynchrone Grenze

Die Store-Aktionen sind synchron (`createCustomer(data): Customer`), eine Fernbuchung kann es
nicht sein. Statt das mit verstecktem Feuern-und-Vergessen zu überbrücken, ist die Grenze jetzt
sichtbar: `await speichern.save(...)`. Am Primary läuft die synchrone Funktion und ihr
Ergebnis wird in den gemeinsamen Vertrag gehoben; die Oberfläche sperrt ihren Knopf, zeigt
„Saving…" und meldet Erfolg **erst nach einem Erfolg**.

Die vier Ausgänge, und warum es genau vier sein müssen:

```
ok             der Vorgang existiert (replayed = er existierte schon)
business_error ein eingefrorenes Nein — der Mensch muss etwas anderes entscheiden
not_executed   nachweislich NICHT gelaufen — dieselbe Kennung darf sofort wieder
unknown        Ausgang offen — KEIN Erfolg; dieselbe Kennung wiederholen, nie eine neue
```

### §5 Eine Kennung je Absicht

Kein neues System: der Wächter aus C3C (`CommandSaveController`) bleibt, wie er ist. Neu ist
nur, dass die gemeinsame Oberfläche ihn benutzt — einer je Formular, über seine Lebensdauer
stabil. Ein zweiter Klick, während der erste läuft, kommt gar nicht erst los (`useRef`-Riegel;
ein Zustandswert stünde erst beim nächsten Zeichnen).

### §7/§8 Am laufenden Programm bewiesen

```
test/uiparity/r4b-write-adapter.test.ts   140/0
test/e2e/r4b-shared-ui-writes.e2e.mjs      49/0   zwei echte Anwendungen, vier echte Formulare
```

Der E2E-Lauf klickt auf einem echten, datenbanklosen zweiten Rechner durch `/clients`,
`/clients/<id>`, `/collection/<id>` und `/invoices/new` — dieselben Routen, dieselben
Knöpfe, dieselben Komponenten wie am Hauptrechner. Danach steht im Datenbestand des Primary
genau ein neuer Kunde mit genau den eingegebenen Werten, die Änderung und **nur** sie, der
geänderte Lagerort bei unangetasteter SKU, und eine Rechnung mit einer Zeile, echtem Betrag und
abgezogenem Bestand. Kein einziger Griff zur lokalen Datenbank.

**Der teuerste Fall** ist eigens gefahren: der Test nimmt der Oberfläche die Antwort weg,
*nachdem* der Primary geschrieben hat (die Anfrage läuft wirklich, danach wirft er). Ergebnis:
die Maske behauptet keinen Erfolg, sondern benennt den Ausgang als offen und bleibt stehen; der
zweite Klick auf denselben Vorsatz geht mit **derselben Kennung** hinaus; und im Datenbestand
steht danach **ein** Kunde, **eine** Rechnung, **eine** Zeile, **eine** Buchung im Hauptbuch.

### §6 Was noch nicht geht, sagt es

Drei Nebenwege sind am Client ausdrücklich gesperrt — mit eigenem Code
(`CLIENT_WRITE_UNSUPPORTED`) und sichtbarer Meldung, nie als stilles Nichts und nie mit
Rückfall auf die lokale Datenbank:

- der **Bildweg** des Artikelformulars (er braucht den Zwischenspeicher- und Galerievertrag),
- das **Ändern** einer Rechnung (eigener Vertrag, nicht in dieser Scheibe),
- eine **Zahlung beim Anlegen** einer Rechnung — `invoices.create` kennt keine; eine Rechnung
  anzulegen und das Geld liegen zu lassen wäre schlimmer als ein ehrliches Nein.

Unter allem anderen liegt der harte Riegel: jede schreibende Store-Aktion holt als erstes die
Datenbank. Auf einem Client wirft sie — laut, nicht still. Das Gate prüft das an allen
schreibenden Store-Aktionen.

### §10 Auftrag → Rechnung: bewusst NICHT

`orders.convert_to_invoice` bleibt unverdrahtet. Die normale Oberfläche des Primary führt bei
dieser Handlung zusätzlich den Anzahlungsübertrag aus; die Fernbuchung allein wäre die halbe
Handlung und ließe Geld liegen. Das wird fachlich atomar gelöst, nicht nebenbei.

### Registry

```
Probe            = 1
C2 Reads         = 18
UI-Parity Reads  = 48
Mutations        = 40   (unveraendert — R4B fuegt KEINE neue Buchung hinzu)
Total            = 107
```

Erreicht aus der gemeinsamen Oberfläche: **4 von 40**. Das ist der Anfang, nicht das Ende — aber
es ist das Muster, an dem die übrigen 36 hängen.

---

## R4C — die vierzig Buchungen, Zeile für Zeile (09.09.2026) · BLOCKED

### §1/§2 Die Matrix ist jetzt die eine Quelle

`test/uiparity/_r4c-write-matrix.ts` hält für JEDE der vierzig Buchungen fest: welche
Handlung sie in der gemeinsamen Oberfläche ist, wo sie sitzt, welche lokale Funktion der
Primary ruft, ob die Semantik deckungsgleich ist, ob sie angeschlossen ist, und warum nicht.
Das Gate (`r4c-write-matrix.test.ts`, 234/0) prüft jede Zeile gegen den echten Quelltext —
Datei, Funktion, Anschluss, Sperre. Die Tabelle kann nicht zur Erzählung werden.

```
11 verdrahtet · 21 exakt aber noch offen · 6 Luecken (Klasse B) · 2 ohne Handlung
```

### Der Fund, der alles andere erklärt: fast jede Geldbuchung will die FASSUNG

Von den vierzig Buchungen verlangen **21** ein `expectedRevision` — die Fassung, die der
Mensch gesehen hat. Ohne sie weist der Primary ab, und das ist richtig so: sonst überschriebe
ein Client blind, was inzwischen jemand anderes getan hat.

Der gemeinsame Lesestand kannte die Fassung aber gar nicht: weder die Modelle noch die
Zeilen-Abbildungen der Stores reichten sie durch. Damit war die halbe Schreibfläche technisch
unerreichbar, unabhängig von jeder Weiche. `rowToInvoice`, `rowToOrder` und
`rowToConsignment` geben sie jetzt weiter; die Masken schicken sie mit und lesen nach dem
Erfolg frisch nach, weil die nächste Handlung die NEUE Fassung braucht.

### §3/§4 Was angeschlossen wurde

```
invoices.update            Rechnungszeilen aendern   (mit Fassung)
invoices.record_payment    Zahlung erfassen
invoices.apply_credit      Guthaben verrechnen       (mit Fassung)
invoices.update_payment    Zahlung berichtigen       (mit Fassung)
invoices.delete_payment    Zahlung loeschen          (mit Fassung)
orders.update_status       Auftragsstatus setzen     (mit Fassung, bestandswirksam)
consignments.mark_returned Kommission zurueckgeben   (mit Fassung, bestandswirksam)
```

Dazu kam eine neue Form der Weiche: `useSharedWrites()`. Eine Rechnungsansicht kennt sieben
Schreibhandlungen; sieben einzelne Weichen wären sieben Zustände und sieben Fehleranzeigen.
Jetzt gibt es einen Zustand und eine Anzeige — aber weiterhin **einen Wächter je Buchung**, denn
die Kennung gehört zur Absicht, nicht zur Seite.

Nebenbefund: die Notiz am Kunden ist DIESELBE Buchung wie das Kundenformular
(`customers.update`), lief aber an der Weiche vorbei und hätte auf einem Rechner ohne
Datenbank geworfen. Sie geht jetzt denselben Weg.

### §7 Die Lücken, genau benannt

| Buchung | Klasse | warum |
|---|---|---|
| `orders.convert_to_invoice` | B | Die Oberfläche führt in DERSELBEN Handlung den Anzahlungsübertrag aus; die Buchung legt nur die Rechnung an. Geld bliebe liegen. |
| `products.create` | B | Die Maske legt Artikel MIT Bildern an; die Buchung nimmt nur zwischengespeicherte Bildkennungen. |
| `consignments.create` | B | Die Maske legt in derselben Handlung auch den Artikel an. |
| `consignments.record_payout` | B | Die Maske zahlt VOLLSTÄNDIG aus; die Buchung kennt nur die Teilauszahlung mit Betrag. |
| `repairs.create` | B | Die Maske legt auch EIGEN-Reparaturen an; die Buchung setzt den Bereich fest auf „Kunde". |
| `repairs.create_invoice` | B | Die Liste rechnet auch MEHRERE Reparaturen in EINE Rechnung ab; die Buchung kennt nur eine. |
| `repairs.update_line`, `transfers.mark_settled` | — | Die gemeinsame Oberfläche bietet die Handlung gar nicht an. |

### Warum R4C BLOCKED ist

Zwei Gründe, beide belegt:

**1. Einundzwanzig deckungsgleiche Buchungen sind noch nicht angeschlossen.** Sie stehen
namentlich in der Matrix (Retouren, Einkauf, Kommissionsverkauf, Auftrag anlegen/ändern,
Anzahlungen, Reparaturen, Transfers). Der Weg dorthin ist jetzt mechanisch — Fassung durchreichen,
`w.ok(op, { local, remote })` — aber er ist Arbeit an rund zwanzig Masken und gehört in eine
eigene Scheibe, nicht in eine Zeile Bericht.

**2. Der zweite Rechner meldet sich als `SALES`, nicht als Eigentümer.** Der Zwei-Rechner-Lauf
kam bis zur Rechnung und blieb dort stehen: „Zahlung erfassen" und „Rechnung ändern" sind an
`perm.canRecordPayments` bzw. `canEditInvoices` gebunden, und beide verlangen ADMIN. Die
Sitzung des Clients trägt aber die Rolle `SALES` — dieselbe Person, die am Hauptrechner
Eigentümer ist, sieht auf dem zweiten Rechner die Knöpfe gar nicht.

Das ist kein Fehler der Weiche und keiner der Buchung: es ist eine offene Frage der IDENTITÄT.
Sie hier nebenbei zu „lösen", hieße Rechte zu erfinden — und Rechte erfindet man nicht in einem
Schreib-Slice. Der Befund steht, die Wege sind gebaut und statisch bewiesen; der laufende Beweis
für die Geldwege fehlt, bis die Rolle geklärt ist.

### Registry

```
Probe = 1 · C2 Reads = 18 · UI-Parity Reads = 48 · Mutations = 40 · Total = 107
```

R4C fügt keine Buchung hinzu — und hat keine gebraucht.

---

## R4C.1 — dieselbe Person, dieselben Knöpfe (09.09.2026)

### Der Befund aus R4C, jetzt erklärt

Derselbe Mensch war am Hauptrechner Eigentümer und auf dem zweiten Rechner Verkäufer. Es war
kein Rechteproblem und kein Serverfehler, sondern eine **Vokabelfrage** — und sie hat die halbe
Geldfläche unsichtbar gemacht.

```
user_branches.role                    = "owner"        (kleingeschrieben, so spricht das Haus)
sync/auth.rs create_token(... role)   = "owner"        (woertlich uebernommen)
sessionFromToken()  ROLES-Liste       = ADMIN|MANAGER|SALES|ACCOUNTANT
                    "owner" nicht dabei → stiller Rueckfall auf "SALES"
usePermission()     canonicalRole("SALES")  = SALES    → keine Zahlungsknoepfe

Am Hauptrechner dagegen:
authService.login() session.role      = "owner"
usePermission()     canonicalRole("owner")  = ADMIN    → alle Knoepfe
```

Es gab also **zwei Übersetzungen** für dieselbe Frage. Die eine (`canonicalRole`) kennt beide
Schreibweisen, die andere (die private Liste im Client) nur eine — und fiel sonst still auf die
engste Rolle zurück. Ein stiller Rückfall ist hier besonders teuer: er sieht aus wie eine
Rechteentscheidung, ist aber ein Tippfehler im Wortschatz.

### Der Fix — die Liste ist weg

`sessionFromToken()` nimmt das Wort des Servers jetzt **wörtlich** und übersetzt gar nicht:
das tut `canonicalRole()`, dieselbe Funktion, die auch der Hauptrechner benutzt
(`usePermission`, `roleHasPermission`). Fehlt der Anspruch ganz, entsteht **keine Sitzung** —
eine Rolle zu erfinden wäre in beide Richtungen falsch.

Dazu die zweite Hälfte, die §3 verlangt: die **aktuelle** Rolle. Ein Ausweis gilt dreißig Tage;
seine Rolle ist ein Abzug vom Moment der Anmeldung. Der Server liest sie bei jeder geschützten
Anfrage neu aus `user_branches` und ersetzt die des Tokens (C4 `reauthorize`).
`refreshClientSessionContext()` übernimmt genau dieses Ergebnis — und nur, wenn es **denselben
Menschen** und **dieselbe Filiale** betrifft. Der Client wählt nichts aus.

### Warum das keine Rechteausweitung ist

Die Rolle entscheidet nur, welche Knöpfe ein Bildschirm zeigt. Was wirklich passieren darf,
entscheidet weiterhin der Primary — pro Anfrage, gegen den aktuellen Zustand. Das Gate hält
beide Richtungen fest:

- Eigentümer: `payments.*`, `invoices.*`, `products.edit`, `customers.edit` auf beiden
  Rechnern **gleich erlaubt**.
- Verkäufer: `payments.*` und `invoices.*` auf beiden Rechnern **gleich verwehrt**.
- Ein unbekanntes Wort landet weiterhin bei der engsten Rolle — nur eben an EINER Stelle.
- Und der Riegel dahinter ist unverändert: ein `SALES`-Absender, der die Buchung trotz
  verstecktem Knopf direkt schickt, bekommt `PERMISSION_DENIED` (C4-Gate, 169/0); ein im
  Rumpf mitgeschickter fremder Absender wird ignoriert.

### Was der Zwei-Rechner-Lauf jetzt zeigt

```
test/uiparity/r4c1-role-parity.test.ts    35/0
test/e2e/r4c-shared-ui-writes.e2e.mjs     30/0   (vorher: an der Rolle stehengeblieben)
```

Der Lauf meldet die Rolle des Clients als `owner`, „Zahlung erfassen" und „Rechnung ändern"
stehen auf **beiden** Bildschirmen gleich da, und die bereits verdrahteten Handlungen sind aus
der normalen gemeinsamen Oberfläche erreichbar: eine Zahlung von 300 landet genau einmal beim
Primary, mit genau einer Buchung im Hauptbuch; der Auftragsstatus wandert weiter und seine
Fassung steigt; die Kundennotiz kommt an. Kein Griff zur lokalen Datenbank, kein
Geschäftsspeicher auf dem Client.

### Zwei Prüfstandsfunde nebenbei

Der Aufbau des E2E sprach an zwei Stellen die falsche Sprache: ein Auftrag mit dem Status
`PENDING` (das Haus schreibt `pending`) hat gar keinen nächsten Schritt, und eine Zahlung
bucht unter IHRER Kennung, nicht unter der Rechnung. Beides waren Fehler des Tests, nicht des
Programms — und beide hätten als „Feature funktioniert nicht" durchgehen können.

### Unverändert

```
Matrix: 11 verdrahtet · 21 exakt offen · 6 Klasse B · 2 ohne Handlung
Registry: 1 + 18 + 48 + 40 = 107
```

R4C.1 schließt keine weitere Buchung an und erweitert keine Rechte. Es macht nur, dass dieselbe
Person auf beiden Rechnern dasselbe sieht.

---

## R4C.2 — der argumentgenaue Vergleich (09.09.2026) · BLOCKED

### Was die Prüfung ergeben hat

R4C hatte 21 Buchungen als „deckungsgleich" geführt. Der Vergleich Feld für Feld — was die Maske
WIRKLICH übergibt gegen das, was die Fernbuchung annimmt — hat **zehn davon widerlegt**, und zwei
weitere fielen beim Verdrahten auf:

| Buchung | was fehlt |
|---|---|
| `returns.create` | `staffId` + „sofort erstatten" ist ein zweiter Vorgang |
| `returns.approve` / `returns.refund` | nur INNERHALB des Rechnungsstornos, kein eigener Knopf |
| `purchases.create` | Zeilen mit NEUEN Artikeln, `staffId`, `sourceOrderId` |
| `consignments.record_sale` | `specialMark` (Belegnummernkreis) |
| `orders.create` | legt zusätzlich die Gold-Verbindlichkeit an |
| `orders.update` | `expectedMargin`, `remainingAmount` |
| `orders.add_payment` | `cardBrand` — davon hängt die Kartengebühr ab |
| `repairs.update` | sechs Felder, darunter die Zahlwege |
| `transfers.create` | `staffId` |
| `transfers.convert_to_invoice` / `..._many` | legen im Modus „auto" erst den KUNDEN an |

Jede dieser Zeilen steht mit ihrem Beweis in der Matrix. Halb zu verdrahten wäre hier teurer als
gar nicht: eine Kartenzahlung mit falscher Gebühr oder ein Auftrag ohne Goldschuld sieht aus wie
Erfolg.

### Was angeschlossen wurde

Neun Buchungen, alle fassungsbasiert:

```
returns.record_refund_payment   Erstattung auszahlen
consignments.update             Kommission aendern (Modell + Stammdaten in EINEM Auftrag)
orders.delete_payment           Anzahlung loeschen
repairs.update_status           Reparaturstatus setzen
repairs.add_line                Arbeitszeile hinzufuegen
repairs.cancel_line             Zeile stornieren
transfers.update                Preis / Rueckgabedatum / Notiz
transfers.mark_returned         zurueckgenommen (bestandswirksam)
transfers.mark_sold             verkauft
```

Voraussetzung war der zweite Teil der Fassungs-Arbeit: `rowToRepair`, `rowToTransfer` und
`rowToReturn` reichen die Fassung jetzt ebenso durch wie Rechnung, Auftrag und Kommission. Wo
eine Seite mehrere Handlungen hat, holt EIN Helfer die Fassung (`fassungVon`,
`fassungOderNichts`) — dieselbe Regel, an einer Stelle statt an fünf.

### Endstand der Matrix

```
20 verdrahtet · 0 exakt aber offen · 18 Luecken (Klasse B) · 2 ohne Handlung = 40
Registry: 1 + 18 + 48 + 40 = 107   (keine neue Buchung)
```

### Warum BLOCKED

§5 verlangt, je Domäne einen NEU verdrahteten Weg real zu fahren — Geld, Bestand, Auftrag,
Kommission, Reparatur, Transfer, Retoure. Gefahren sind bisher die Wege aus R4C/R4C.1 (Zahlung,
Auftragsstatus, Kundennotiz, Knopf-Parität): `r4c-shared-ui-writes.e2e.mjs` 30/0, unverändert
grün. Die neun neuen Wege sind statisch bewiesen (Matrix-Gate 335/0), aber noch nicht am
laufenden Programm gefahren. Das fehlt — und es steht hier als offener Punkt, nicht als stille
Annahme.

---

## R4C.3 — gefahren statt behauptet (09.09.2026) · BLOCKED

R4C.2 hatte neun Buchungen angeschlossen und das statisch bewiesen. Das Fahren an zwei echten
Rechnern hat **zwei echte Fehler** gefunden, die kein Gate hätte finden können — und beide
gehören zur teuersten Sorte: sie sehen aus wie „funktioniert nicht" und sind in Wahrheit ein
Absturz bzw. ein zweites Vokabular.

### Fund 1 — die Rechnungsansicht stürzte ab, sobald eine Retoure daranhing

```
/invoices/<id> mit Retoure  →  UI CRASH: Error: Database not initialized
```

`getReturnCancelability()` fragt beim ZEICHNEN, ob eine Retoure noch stornierbar ist — für
jede Retoure, in der Storno-Schaltfläche. Die Antwort holt sie aus `customer_credits`. Auf
einem Rechner ohne eigene Datenbank warf das mitten im Aufbau und riss die ganze Ansicht mit.

R4A hatte die Rechnungsansicht datenbanklos bewiesen — mit einer Rechnung OHNE Retoure. Der Weg
war da, nur nie betreten. Die Funktion antwortet jetzt fail-closed („nur am Hauptrechner möglich")
statt zu werfen — dieselbe Haltung, die `getInvoiceCardInfo` eine Funktion weiter unten schon
hatte.

### Fund 2 — `repairs.add_line` spricht ein anderes Vokabular

```
Haus  (RepairWorkType):  service | polishing | spare_part | gold_work | stone_setting | …
Buchung (WORK_TYPES):    labor | polish | plating | stone | diamond | gold | parts | other | material
Ueberschneidung:         plating — ein einziges Wort
```

Die normale Eingabe der Maske wird abgewiesen: „unknown work type: service". Das ist **dieselbe
Sorte Fehler wie die zweite Rollenliste in R4C.1** — zwei Vokabulare für dieselbe Sache, und das
zweite ist nie mitgewachsen. Die Buchung ist deshalb zurück in Klasse B; verdrahtet wird sie,
wenn die Listen zusammengeführt sind, nicht vorher.

### Was wirklich gefahren wurde

```
test/e2e/r4c3-lifecycle-writes.e2e.mjs   58 bestanden / 3 offen

returns.record_refund_payment   Erstattung 300 ausgezahlt, genau eine Buchung im Hauptbuch
consignments.update             650 statt 500, Fassung gestiegen, PC2 sieht es nach frischem Lesen
repairs.update_status           Status weiter, Fassung gestiegen
transfers.update                Preis 850, Fassung gestiegen
transfers.mark_sold             Zustand „verkauft" mit echtem Preis
transfers.mark_returned         Zustand „zurueckgenommen", Artikel wieder im Bestand
orders.delete_payment           genau die Zielzahlung weg, Fassung gestiegen

offen: repairs.cancel_line — die Schaltflaeche war in diesem Aufbau nicht erreichbar
```

Über den ganzen Lauf: kein einziger Griff zur lokalen Datenbank auf dem zweiten Rechner, keine
`lataif.db`, kein Datenort, kein Ausgangskorb.

### Stand

```
19 verdrahtet · 0 exakt aber offen · 19 Luecken (Klasse B) · 2 ohne Handlung = 40
Registry: 1 + 18 + 48 + 40 = 107   (unveraendert)
```

### Warum BLOCKED

Zwei Gründe, beide benannt: die Matrix steht nach dem Fund bei **19/19** statt bei den erwarteten
20/18 — `repairs.add_line` musste zurück —, und `repairs.cancel_line` ist als einzige der
neu angeschlossenen Buchungen noch nicht real gefahren. Sieben von neun sind es.

---

## R4C.4 — eine Liste statt zweier (09.09.2026)

### Der Wortschatz, nachgezählt

```
Primary-Maske  → <select> mit 8 Optionen  → RepairWorkType (nur ein TYP, kein Wert)
                 service polishing spare_part gold_work stone_setting engraving plating other
repairs.add_line → WORK_TYPES (eigener Wert, zur Laufzeit lesbar)
                 labor polish plating stone diamond gold parts other material
Ueberschneidung  → plating, other
```

Der Grund für die zweite Liste ist belegbar: sie stammt aus der zurückgebauten Client-Hülle
(`ClientLifecyclePanels` setzt bis heute `workType: 'labor'`). Und sie war nötig, weil die
Liste des Hauses **nur ein Typ** war — zur Übersetzungszeit sichtbar, zur Laufzeit nicht
lesbar. Wer prüfen muss, kann einen Typ nicht fragen; also hat jemand abgeschrieben, und das
Abgeschriebene ist nie mitgewachsen.

### Kein Altvertrag hing daran

Bewiesen, nicht vermutet: `repair_lines.work_type` ist ein `TEXT` ohne Prüfregel, der
Altbestand-Einfüger schreibt `'service'`, und `labor/diamond/stone/gold` gehören im
übrigen Code zur **Materialart** (`AddMaterialModal`), nicht zur Arbeitsart. Deshalb: kein
Alias, keine Rückwärtsgrenze — die alten Wörter waren nie ein Vertrag.

### Der Fix

```
export const REPAIR_WORK_TYPES = [...] as const;      // die eine Liste, als WERT
export type RepairWorkType = typeof REPAIR_WORK_TYPES[number];
        ↓                                   ↓
RepairDetail <select>              lifecycle-commands WORK_TYPES
```

Die Maske zeichnet ihre Auswahl aus der Liste, der Fernbefehl prüft gegen dieselbe. Zwei Leser,
eine Quelle. Das Gate hält fest, dass keine der beiden Seiten wieder eine eigene bekommt.

### Und dann wirklich gefahren

```
test/e2e/r4c3-lifecycle-writes.e2e.mjs   73/0

repairs.add_line     Arbeitszeile ueber die normale Maske, Arbeitsart aus der Auswahl
                     ("service") → vom Fernbefehl angenommen, genau EINE Zeile, richtige
                     Kosten, Fassung der Reparatur gestiegen, PC2 sieht sie nach frischem Lesen
repairs.cancel_line  ueber die sichtbare Schaltflaeche → die Zeile ist weg; ein zweiter Versuch
                     findet die Schaltflaeche nicht mehr und hinterlaesst nichts
```

Zwei Prüfstandsfunde nebenbei: der Aufbau hatte seiner Reparaturzeile keine Filiale gegeben
(die Selbstheilung setzte `''` ein — der zweite Rechner sah sie deshalb nie), und die
Erwartung „Zeile steht auf CANCELLED" war falsch: das Haus **entfernt** sie
(`DELETE FROM repair_lines`). Beides Fehler des Tests, die wie Produktfehler aussahen.

### Stand

```
20 verdrahtet · 0 exakt aber offen · 18 Luecken (Klasse B) · 2 ohne Handlung = 40
Registry: 1 + 18 + 48 + 40 = 107   (unveraendert)
```

Damit sind alle zwanzig angeschlossenen Buchungen aus der gemeinsamen Oberfläche erreichbar —
und jede davon ist an zwei echten Rechnern gefahren worden.

---

## R5A — Auftrag und Anzahlung (09.09.2026) · BLOCKED

### Die vier Order-Zeilen aus den achtzehn Klasse-B-Fällen

```
orders.create              legt zusaetzlich die Gold-Verbindlichkeit an        → bleibt B
orders.update              schickt expectedMargin / remainingAmount mit        → bleibt B
orders.add_payment         cardBrand fehlte → falsche Kartengebuehr            → GESCHLOSSEN
orders.convert_to_invoice  Anzahlungsuebertrag fehlte → Geld bleibt liegen     → GESCHLOSSEN
```

### Der Kern: die Rechnung wohnte in der Oberfläche

Warum die Umwandlung seit R3 offen war, ist beim Nachsehen sofort sichtbar:
`carryOverOrderPaymentsToInvoice` stand **in der Auftragsansicht** — mitten in einer
React-Komponente. Der Fernbefehl konnte sie gar nicht rufen, also legte er nur die Rechnung an.

Sie ist jetzt eine Domänenfunktion (`core/orders/order-payment-carryover.ts`), Wort für Wort
dieselbe Rechnung, nur an einem Ort, den beide Seiten erreichen — und beide rufen sie:

```
OrderDetail (Primary)          financial-commands (runConvertOrder)
        ↓                                   ↓
        carryOverOrderPaymentsToInvoice(...)   ← eine Funktion, kein Nachbau
```

Beim Fernbefehl läuft sie **innerhalb derselben Transaktion**: scheitert der Übertrag, fällt die
ganze Umwandlung zurück. Den Zustand „Rechnung da, Geld liegt beim Auftrag" kann es nicht mehr
geben — und der Client schickt für diese eine Handlung genau **einen** Befehl, kein Nacheinander.

### Die Kartengebühr

`orders.add_payment` nahm `cardBrand` nicht entgegen. Das ist Geld: die Gebühr ist 2,5 %
für Amex gegen 2,2 % sonst. Eine Amex-Anzahlung vom zweiten Rechner wäre mit dem normalen Satz
gebucht worden. Das Feld reist jetzt mit — **gerechnet** wird die Gebühr weiterhin ausschließlich
im Haus (`bookCardFee` in `addPayment`), nie im Client.

Dabei dieselbe Lehre wie bei den Arbeitsarten (R4C.4) gleich mit angewandt: `CARD_BRANDS` ist
jetzt ein **Wert**, aus dem der Typ folgt — sonst hätte der Fernbefehl wieder eine eigene Liste
gebraucht.

### Registry und Matrix

```
22 verdrahtet · 0 exakt aber offen · 16 Luecken (Klasse B) · 2 ohne Handlung = 40
Registry: 1 + 18 + 48 + 40 = 107   (keine neue Buchung — die vorhandene wurde erweitert)
```

### Warum BLOCKED

Der Entwurf, die gemeinsame Domänenfunktion, die atomare Klammer, der Kartenart-Vertrag und die
Matrix sind fertig und geprüft (Matrix-Gate **361/0**, beide TS-Gates sauber). Der **laufende**
Beweis fehlt: im Zwei-Rechner-Lauf (`r5a-order-conversion.e2e.mjs`) kam die Anzahlung durch,
aber die Umwandlung löste keine Buchung aus — die Schaltfläche war da, der Weg brach vorher ab
(vermutlich sieht der zweite Rechner die Auftragspositionen nicht als „abrechenbar"). Das ist
die nächste Frage, und sie gehört gestellt, bevor hier „bewiesen" steht.

---

## R5A.1 — warum PC2 keinen Auftrag abrechnen konnte (09.09.2026) · BLOCKED

### Der Abbruch lag VOR der Buchung

```
Klick „Create Invoice"
  → handleCreateFinalInvoice
  → getBillableLines(id)            ← 0 Positionen auf PC2
  → alert("Nothing ready to invoice") und return
  (der gemeinsame Schreibweg wurde nie erreicht)
```

### Die Ursache — und sie ist groesser als die Umwandlung

`getOrderLines()` fragte ausschliesslich die lokale Datenbank, und ein `try` darum verschluckte
den Fehler. Auf einem Rechner ohne Datenbank hiess das nicht „Fehler", sondern: **der Auftrag hat
keine Positionen**. Keine Meldung, kein Absturz, nur eine leere Liste — und damit ist auf dem
zweiten Rechner JEDE Handlung tot, die an Positionen haengt.

Der Rundgang aus R4A hat das nicht gefunden, weil er auf Abstuerze und Datenbankgriffe schaut;
ein geschluckter Fehler sieht aus wie ein leerer Auftrag.

### Der Fix (kleinster Leseweg, keine neue Buchung)

```
loadOrdersFor(ctx) → { orders, orderLines }     ← die Positionen reisen mit, filialgebunden
getOrderLines(id)  → Primary: Datenbank (wie bisher)
                     Client:  derselbe Lesestand, den auch die Auftragsliste fuellt
```

Die Zeilen-Abbildung war eine anonyme Funktion INNERHALB von `getOrderLines`; sie heisst jetzt
`rowToOrderLine` und wird von beiden Wegen benutzt — abgeschrieben ist nichts. Am Primary bleibt
die Datenbank die Quelle, damit der Speicherstand nach dem Anlegen einer Position nicht veraltet.

### Stand

```
Matrix 22 verdrahtet / 0 exakt offen / 16 Klasse B / 2 ohne Handlung · Registry 107
Matrix-Gate 365/0 · Lesegates r1/r2d/c2 gruen · beide TS-Gates sauber
```

### Warum weiterhin BLOCKED

Der Lesefehler ist behoben und geprueft, aber der Zwei-Rechner-Lauf loeste die Umwandlung immer
noch nicht aus: die Schaltflaeche ist da und wird geklickt, es geht keine Buchung hinaus. Der
naechste Schritt ist, den Weg NACH `getBillableLines` am laufenden Client zu protokollieren
(Bestaetigungsdialog der Steuerschemata bzw. die Weiche davor) — nicht wieder zu raten.

---

## R5A.2 — Auftrag → Rechnung, der Weg nach „abrechenbar" (10.09.2026)

### Der echte Weg, am laufenden Client gelesen

```
Create Invoice → handleCreateFinalInvoice → getBillableLines (PC2: 1, Primary: 1)
  → alle Zeilen mit gespeichertem Schema → Schema-Dialog („VAT-Schema bestaetigen", Weiter)
  → Nummern-Dialog („Choose Invoice Number Type", Confirm)
  → convertWithPersistedSchemes → w.save → orders.convert_to_invoice   (genau eine Buchung)
```

Der R5A.1-Lauf klickte nach „Create Invoice" auf einen Knopf namens *Create Invoice* — das war
wieder die Schaltfläche der Seite, nicht der Dialog. Der Dialog heißt „Weiter", danach kommt der
Nummern-Dialog. Beide werden jetzt bedient, nicht umgangen.

### Drei Funde auf diesem Weg

1. **Der Fernbefehl rechnete die Rechnungszeilen selbst — und anders.** Steuer immer obendrauf
   (`netto × Satz`): bei MARGIN 10 % zu viel auf der Rechnung, beim Sonderstück mit VAT_10 die
   Steuer zweimal. Die Rechnung stand in der Auftragsansicht; sie ist jetzt wortgleich in
   `core/orders/order-invoice-lines.ts` und beide Seiten rufen sie.
2. **Die Wahl der Dialoge fiel still weg.** Schema je Zeile, Nummernart und „abschließen" reisen
   jetzt als geprüfte Felder im bestehenden Befehl mit (`taxSchemes`, `specialMark`, `markComplete`;
   Schemata gegen `TAX_SCHEMES`, das jetzt ein Wert ist). Die Schlüssel von `taxSchemes` müssen
   genau die abrechenbaren Zeilen sein — sonst `ORDER_LINES_CHANGED`, nie eine andere Menge.
3. **Ein offener Ausgang verschwand still.** `useSharedWrites.save` gab ihn nur zurück; die
   Umwandlung kehrte bei verlorener Antwort wortlos um. Jetzt legt auch `save` den Grund in
   `w.fehler`.

Ausdrücklich abgelehnt auf dem Client (kein lokaler Schreibversuch): Aufträge ohne gespeichertes
Schema (der Altweg legt vor dem Dialog einen Artikel an) und Positionen ohne Artikel (der
Fernbefehl legt keinen an — `ORDER_LINE_WITHOUT_PRODUCT`).

### Laufzeit, zwei echte Rechner

```
Primary vs PC2 vor der Entscheidung: bereit=1, [R5A Chronometer · Zero] — identisch
Dispatch: orderId r5a-ord · expectedRevision 4 · taxSchemes {r5a-line: ZERO} · special false
Rechnung 1000, bezahlt 1200 aus der Anzahlung, Gutschrift 200 = Ueberzahlungsanteil, Rest 0
Antwort verloren: Banner „not clear whether", zweiter Klick → dieselbe Kennung, derselbe Rumpf,
  eine Rechnung, Zahlungen 1/300, Hauptbuch 2 → 2, Anzahlungszeilen unverändert
```

Matrix unverändert **22 / 0 / 16 / 2**, Registry **107** — keine neue Buchung, der bestehende
Befehl wurde exakt gemacht.

---

## R5A FINAL — Buchhaltung festgenagelt, lokal = fern (11.09.2026)

### Die Überzahlung, bitgenau (Vorschuss 1200, Rechnung 1000)

```
Rechnung   gross 1000 · paid_amount 1200 · FINAL
Zahlungen  400 + 600 (bis zur Summe) + 200 (Ueberzahlungsanteil), alle cash
Hauptbuch  AR  Soll 1000 / Haben 1000 → Saldo 0     REVENUE −1000   COGS 400 / INVENTORY −400
           CASH +1200 (genau einmal)                CUSTOMER_CREDIT −200
Gutschrift genau eine: 200, overpayment, OPEN, unbenutzt
Auftrag    offene Anzahlung 0 · deposit 0 · completed
```

Auf die Forderung werden genau **1000** angerechnet. `paid_amount = 1200` ist der bestehende
Hausvertrag (Slice 3): der Rechnungskopf führt den ERHALTENEN Betrag, der Teil über der Summe wird
in `recordPayment` als Kundenguthaben gebucht statt als negative Forderung.

### Lokal = fern

Ein Zwilling desselben Auftrags wird am Primary über die normale Oberfläche umgewandelt, das Original
vom datenbanklosen PC2. Verglichen (ohne Kennungen, Nummern, Zeiten, Freitexte): Rechnungskopf,
Zeilen, Zahlungen, Gutschrift, Auftrag samt Fassung, Positionen, Anzahlungen, jede neue
Hauptbuchzeile, Los und Artikel — **alle zehn identisch**, Kontensalden identisch.

Nebenbefund im Test: der lokale Weg speichert über den verzögerten Speicherpfad, der Fernbefehl
durabel — der Vergleich wartet deshalb, bis der lokale Stand auf der Platte steht.

### Transaktionsgrenze

Fehler im Test in `recordPayment` gelegt (`setState`, kein Produkt-Hook): zu diesem Zeitpunkt
existiert die Rechnung und die Anzahlung ist schon umgebucht. Danach: keine Rechnung, keine Zeile,
keine Zahlung, keine Gutschrift, Hauptbuch unverändert, Auftrag nicht berechnet, Anzahlung
unverändert, Los unverändert, Fassung unverändert. Die Wiederholung läuft; Anzahlungsschuld 0,
Forderung = Summe − 300.

### Eingaben des Clients

Abgelehnt: fremde Position (eines anderen Auftrags), leeres/unbekanntes/Alt-Schema, Nummernart
oder Abschluss als Nicht-Boolean, und jede Summe, Zeile, Kosten, Übertrags-, Bezahlt- oder
Lagerangabe. Beträge, Kosten, Lager, Übertrag und Buchung bestimmt allein der Primary.

---

## R5B — Artikel und Kommission anlegen, mit Bild (11.09.2026)

### Umfang

Aus den 16 Klasse-B-Zeilen genau zwei: `products.create` und `consignments.create`. Nicht angefasst:
Verkauf/Auszahlung der Kommission, Aufträge, Reparaturen, Retouren, Einkauf, Transfers.

### Artikel: was fehlte

```
Maske (Primary)                         Fernbefehl (vorher)
Pflichtfelder nach field-contract       nur „Kategorie + Name"   → Goldkette ohne Namen abgelehnt,
                                                                    Pflichtattribut nie geprüft
veraltete Attribute gestrichen          nicht gestrichen
eingetippte SKU (getrimmt, Riegel)      sku verboten             → Maske auf PC2 halb
stockStatus/sourceType nicht angeboten  vom Rumpf setzbar        → Kommissionsware ohne Kommission
```

Jetzt EINE Vorbereitung (`core/products/product-create.ts`, `planProductCreate`) für Maske und
Fernbefehl; `stockStatus`/`sourceType` bestimmt beim Anlegen der Primary. Der Anlageweg selbst
(`createProductWithMedia`) war schon gemeinsam.

### Bilder: vorhandene Pipeline, kein zweiter Weg

Die Maske hält ihre Bilder als Daten-URL. Auf PC2 gehen genau diese Bytes über die vorhandene
Zwischenablage (`/api/staging/media`, Inhaltshash, Eigentümer aus dem Ausweis); der Auftrag nennt nur
die Kennungen. Der Primary holt die Bytes INNERHALB des Auftrags und fährt denselben
Medienweg. Ein unvollständiger Bilderweg nimmt beim Fernbefehl alles zurück; eine Wiederholung
derselben Kennung erzeugt weder Artikel noch Bild doppelt. Verwaiste Dateien → bestehende
Müllabfuhr (Staging-TTL beim Start, Orphan-GC).

Nebenfund: die gemeinsame Oberfläche zeigte auf PC2 zu **keinem** Artikel ein Bild — der
Resolver fragt die lokale Datenbank. `useProductMediaPresentation` liest dort jetzt über die
bestehende Auskunft `products.get` (Speicherschlüssel) und die angemeldete Medienroute.

### Kommission: ein Vorgang statt zwei

Die Maske rief `createProduct` und danach `createConsignment` — zwei getrennte Schreibvorgänge
ohne Klammer (scheiterte der zweite, blieb ein Artikel „in Kommission" ohne Kommission), die
Bilder als Text in `products.images`. Der Fernbefehl nahm weder Bilder noch SKU, Attribute, Steuer,
Lagerort, Lieferumfang oder Mitarbeiter. Jetzt: `core/consignment/consignment-create.ts` —
Artikel über den Medienweg, Kommission, Modell über `buildPayoutPatch`, in EINER Transaktion; am
Primary klammert `createConsignmentOnPrimary`, beim Fernbefehl der Auftrag. PC2 schickt EINEN
Auftrag, nie `products.create` + `consignments.create`.

### Beweise

```
Unit  product-remote-write 119/0  (SKU getippt/vergeben, Pflichtfelder, Streichen, Filiale,
                                   fremde Ablage, Kommission remote+lokal, Fehler zwischen
                                   Artikel und Kommission → nichts bleibt, Replay)
E2E   r5b-create-parity 54/0      (PC2: Artikel + Kommission mit echtem Foto, je genau einmal,
                                   Bild auf beiden Rechnern, verlorene Antwort ohne Doppel,
                                   Kommission PC2 == Primary-Maske inkl. Bildbytes)
Registry 107 · Matrix 24 / 0 / 14 / 2
```

---

## R5B FINAL — Vertrag, Altbestand, Medien, Test-Harnesses (11.09.2026)

### SKU — kein neuer Vertrag

Beide Masken konnten VOR R5B eine SKU eintippen: Collection trimmte sie und blockte eine vergebene
(`isSkuTaken`: getrimmt, ohne Groß/Klein); die Kommissionsmaske über `resolveSkuDurable` (trimmt)
mit demselben Riegel. Leer oder nur Leerzeichen → Zähler; ein Bild-Retry nutzt die beanspruchte
Nummer weiter. `planProductCreate` bildet genau das ab — der Fernbefehl verbot die Eingabe bisher nur.

### cost_split — eine Regel

`buildPayoutPatch` (v0.8.51) verlangt 1–99 % und wird von Ändern (Maske + Fernbefehl) und vom
Fernanlegen benutzt. Die alte Anlegemaske hatte keine Regel, nur eine Klemme mit Nebenwirkungen:
„0" wurde über `|| 50` zu 50, negative Werte zu 0, >100 zu 100 — also historisch inkonsistent,
nicht die kanonische Regel. 0 % gibt dem Shop nichts, 100 % ist `consignor_fixed` unter falschem Namen.

### Altbestand

Bilder als Text in `products.images` bleiben unverändert (keine Migration) und werden auf BEIDEN
Rechnern gezeigt: am Primary über Schritt 1 des Resolvers, auf PC2 über denselben Schritt in
`useProductMediaPresentation` (der gemeinsame Artikelbestand bringt die Altspalte mit). Neue Bilder
kommen auf PC2 über `products.get` + `/api/media`.

### Zwei Transaktionsfehler, gemessen und behoben

Im Zwei-Rechner-Lauf stand — nicht in jedem Lauf — nach einem gescheiterten Fernauftrag ein
Artikel „in Kommission" ohne Kommission in der Datenbank. Ursachen:

1. **Der Zeitgeber-Sync schrieb neben der Warteschlange** (Push-Markierungen, Fortschritt,
   Operationen) — auch mitten in einen Fernauftrag, der seine Transaktion offen hatte und auf
   Medien wartete. Er läuft jetzt IM exklusiven Platz (`runExclusive`).
2. **Der Speicherdurchlauf zog ein Abbild aus einer offenen Transaktion** (`db.export()` beendet
   sie in sql.js still). Jetzt nie: `isReady` verlangt „keine offene Transaktion"; ein
   durables Speichern, das dadurch nicht schrieb, meldet sich nicht als durabel.

Dazu: das Anwenden von Operationen ließ den Transaktionszähler nach jedem Erfolg eine Stufe zu
hoch stehen und setzte ihn bei einem inneren Fehler für ALLE zurück — beides ausgeglichen.

### Harnesses

Die vier nachgezogenen Tests stellen nur die IPC-Grenze zu Rust (dieselbe wie im Produkttest) und
dieselbe echte sql.js-Testdatenbank auch für den Importweg des Medien-Orchestrators; dazu das
echte Medienschema. Keine Prüfung entfernt außer „SKU verboten" (ersetzt durch fünf Verbote und
die getrimmte Eingabe), kein `skip`.

```
Unit  product-remote-write 141/0 · save-in-transaction 13/0 · Harness-Gate im Matrixtest
E2E   r5b-create-parity 74/0 ×3  (Altbestand + neu auf beiden Rechnern, Primary==PC2 für Artikel
                                   und Kommission inkl. Bildbytes und Protokoll)
Registry 107 · Matrix 24 / 0 / 14 / 2
```

---

## R5C — Reparatur anlegen, ändern, abrechnen (10.09.2026)

### Befund

- **Anlegen:** der Fernbefehl legte fest eine Kundenreparatur an. Die Reparatur an eigener Ware
  (Artikel, Los, Platzhalter-Kunde, `in_repair`) fehlte, ebenso Kategorie, Pflichtfelder der Kategorie,
  Merkmale, Referenz, Beschreibung, Mitarbeiter und Fotos. Dafür nahm er `MARGIN` und `externalVendor` an,
  die keine Maske anbietet.
- **Ändern:** elf Felder der „Save"-Maske fehlten (Zahlwege, Kartenart, Kategorie, Merkmale, Referenz,
  Beschreibung, Problem, Fotos …); die Matrix nannte sechs.
- **Abrechnen:** der Fernbefehl kannte nur genau eine Reparatur; die Detailseite hatte eine eigene Kopie der
  Rechnungslogik mit zwei Schreibvorgängen ohne Klammer.

### Lösung — eine Regelstelle, ein Anschluss je Seite, keine neue Buchung

- `core/repairs/repair-rules` (rein, ohne Datenbank): Pflichtfelder, OWN-Regel, `normalizeRepairCreate` /
  `planRepairCreate`, `buildRepairEditPatch` (eigene Kosten, Marge, Kartenart), `repairInvoiceBlocker`,
  `repairInvoiceNotes`, die Rümpfe des zweiten Rechners. Der Wortschatz steht als Wert in `types.ts`.
- `core/repairs/repair-house`: der Primary-Anschluss aller drei Handlungen in EINER Klammer (exklusiv,
  Ledger-Transaktion, danach durabel).
- Erweitert, nicht neu: `repairs.create` (OWN, alle Felder, Fotos über die vorhandene Zwischenablage),
  `repairs.update` (alle Felder; Fotos als `{ keep }` / `{ stagingId }`), `repairs.create_invoice` (eine
  oder mehrere Reparaturen desselben Kunden, jede mit ihrer Fassung; die Dialogwahl nur bei genau einer).

### R5C FINAL — die Verträge des Primary, einzeln geprüft

**Abrechenbar — entschieden (12.09.2026):** abrechenbar ist eine Reparatur, wenn sie **fertig** (`ready`/`READY`) oder
**abgeholt** (`picked_up`/`DELIVERED`) ist; alle übrigen Bedingungen bleiben (nicht schon fakturiert, keine eigene Ware, ein
Preis, ein Kunde). Nicht abrechenbar: empfangen, in Arbeit, zurückgegeben und jeder andere offene Status. Die EINE Liste
`REPAIR_INVOICEABLE_STATUSES` in `repair-rules` entscheidet für Listenauswahl, Kürzel, Detailknopf, Hausfunktion und
Fernbefehl. Vor R5C galten drei Regeln (Store/Auswahl/Fernbefehl nur fertig; Kürzel sichtbar auch bei abgeholt, dort
aber abgelehnt; Detailseite ohne Statusprüfung).

**Rechnungsvermerk — wieder wie vor R5C, je Handlung:** Detailseite (Einzelrechnung über die Dialoge)
`Repair Service · Nr · Problem`; Liste — Auswahl UND Kürzel, beide ohne Dialog, das Kürzel rief schon immer die
Sammelfunktion — `Combined Repair Service · Nr, …`. Die Dialogwahl (Steuer, Nummernart) gibt es nur bei genau einer
Reparatur; eine Nummernart ohne Steuerdialog oder ein Dialog über mehrere ist keine Handlung des Hauses.

**Ausgeblendete Felder — nur beim Anlegen, nur liegengebliebene Werte:**

| Feld | sichtbar | ausgeblendet | vor R5C gespeichert | R5C |
|---|---|---|---|---|
| Kunde, Kundenpreis | Kundenreparatur | eigene Ware | nie (die Maske leerte beides beim Umschalten) | unverändert |
| Artikel | eigene Ware | Kundenreparatur | nie (die Maske leerte ihn) | unverändert |
| Los | eigene Ware mit >1 Los | Kundenreparatur | ja — `lot_id` an einer Kundenreparatur | nicht mehr |
| Steuerwahl | Kundenreparatur | eigene Ware | der zuletzt gewählte Wert | Vorgabe des Hauses `VAT_10` |
| Seriennummer, Beschreibung, Merkmale | Kundenreparatur | eigene Ware | ja, liegengeblieben | nicht mehr |
| Marke, Modell, Referenz, Kategorie | Kundenreparatur | eigene Ware (vom Artikel) | vom Artikel beim Auswählen | vom Artikel, frisch gelesen |
| Werkstatt | Fremd-/Mischarbeit | Arbeit im Haus | ja, ohne Arbeitszeile | nicht mehr |

Beim **Ändern** löscht R5C nichts, was gespeichert ist: die Kartenart geht nur, wenn der Mensch den Zahlweg sichtbar
wechselt (vor R5C genauso), und sie kommt beim Zurückwechseln nicht wieder; `externalVendor` und die Steuer, für die die
Maske kein Feld hat, bleiben unberührt — vor R5C schrieb „Save" sie zurück, `MARGIN` dabei still als `VAT_10`.

**Beträge:** geprüft werden genau `estimatedCost`, `actualCost`, `internalCost`, `chargeToCustomer` (≥ 0; 0 bleibt
erlaubt). Das ist der Vertrag des Fernbefehls seit C3F (`money()`); die Maske des Primary prüfte nichts. Die Spalten sind
Voranschlag, Kosten und Preis; jeder Verbraucher bucht nur Werte > 0 (Kundenzahlung, Rechnung, Werkstattgebühr,
Arbeitszeile), eine CHECK-Regel gibt es nicht, einen negativen Fachfall auch nicht. Zahlenmerkmale einer Kategorie
sind keine Beträge und bleiben ungeprüft.

```
Unit  r5c/repair-parity 286/0 (lokal == fern inkl. Buchungen, Fehlerinjektion, Autorität, die vier Verträge)
E2E   r5c-repair-parity 117/0 (dazu Umschalten in der Maske und Karte → Bar → Karte, Primary == PC2)
E2E   r5c-billable 27/0 (fertig und abgeholt abgerechnet, empfangen/in Arbeit/zurückgegeben nicht angeboten, Primary == PC2)
Registry 107 · Matrix 27 / 0 / 11 / 2
```

## R5D — Agenten-Transfer: anlegen, umwandeln, gesammelt umwandeln (12.09.2026)

### Befund

- **Anlegen:** die Maske („New Transfer") schickt den Mitarbeiter (`staffId`) — die Fernbuchung kannte das Feld nicht
  (der alte Klasse-B-Grund, bestätigt). Der Primary schrieb Agent, Bestandswechsel und Transfer in drei Schritten ohne
  Klammer und prüfte weder Lagerstand noch „schon draußen"; der Fernbefehl ließ den Anteil nur mit 1–99 % zu, die Maske
  mit 0–100 %.
- **Einzeln umwandeln:** „Auto-create from agent" legte **immer** einen neuen Kunden aus dem Agenten an (Vorname = erstes
  Wort, Rest Nachname, Firma, Telefon, WhatsApp, E-Mail, Vermerk) — ohne Abgleich, auch wenn der Agent schon einen Kunden
  kennt, und VOR der Umwandlung: scheiterte sie, blieb der Kunde stehen. Die Fernbuchung kannte nur einen gewählten Kunden.
- **Gesammelt:** dieselbe Handlung für mehrere Transfers EINES Agenten, EINE Rechnung. Die Auswahl der Liste nimmt nur
  verkaufte ohne Rechnung; der Fernbefehl nahm auch abgerechnete.

### Lösung — eine Regelstelle, eine Folge, keine neue Buchung

- `core/agents/transfer-rules` (rein): `normalizeTransferCreate` / `planTransferCreate`, `canConvertTransfer`,
  `canCombineTransfer`, `transferConvertBlocker`, `agentAutoCustomer` (der Kunde aus dem Agenten — an genau einer
  Stelle), die Rümpfe des zweiten Rechners.
- `core/agents/transfer-house`: `createTransferInHouse`, `convertTransferInHouse`, `convertTransfersInHouse` — die EINE
  Folge, die der Fernbefehl in seiner Transaktion ruft; `…OnPrimary` fährt dieselbe Folge für die Masken des Primary,
  exklusiv, in EINER Transaktion, danach durabel.
- Erweitert, nicht neu: `transfers.create` (+ `staffId`), `transfers.convert_to_invoice` und
  `transfers.convert_many_to_invoice` (+ `autoCustomer: true` — Name, Firma und Kontakte nimmt der Primary vom Agenten,
  nicht aus dem Rumpf). Liste und Detailseite rufen dieselbe Umwandlung.

### Verträge des Primary, die sich bewusst ändern

| Punkt | vor R5D | R5D |
|---|---|---|
| Our Price | die Maske nahm auch negative Werte | > 0 (der Vertrag des Fernbefehls seit C3F) |
| Anlegen | drei Schreibvorgänge ohne Klammer | eine Klammer; das Stück muss im Lager und nicht schon draußen sein |
| Mitarbeiter | jede Kennung | nur ein aktiver der Filiale (die Auswahl der Maske) |
| Auto-Kunde | vorab angelegt, blieb bei einem Fehler stehen | in derselben Klammer wie die Rechnung |
| Sammelrechnung (fern) | nahm auch „settled" | nur „sold" — wie die Auswahl der Liste |
| Anteil (fern) | 1–99 % | 0–100 %, ohne Eingabe 50 — wie die Maske |
| Kunde (fern) | auch Platzhalter `sys-…` | nur Kunden der Auswahl |

```
Unit  r5d/transfer-parity 195/0 (lokal == fern inkl. Buchungen, Fehlerinjektion an vier Stellen, Autorität)
E2E   r5d-transfer-parity 108/0 (anlegen, einzeln, auto, gesammelt, verlorene Antworten, Fehler mitten in der Sammelrechnung, Nachbarn, Primary == PC2)
Registry 107 · Matrix 30 / 0 / 8 / 2
```

### R5D.1 — die übrigen Einstiege, die Verträge gegen den Stand vor R5D (`27768c0`)

- **Detailseite:** „Edit", „Mark as Sold" (auch unter Our Price mit Bestätigung) und „Mark as Returned" laufen über
  dieselben Buchungen wie die Transferliste (`transfers.update` / `.mark_sold` / `.mark_returned`). Liste und
  Detailseite schreiben beim Ändern denselben Satz (`transferEditPatch`): genau Preis, Rückgabedatum (leer = keins) und
  Notiz. Vorher schrieb der Primary den ganzen geladenen Transfer zurück, Status und Abrechnung inklusive.
- **„+ New Client"** der Anlegemaske: die Schnellanlage legt über die vorhandene Buchung `customers.create` an (derselbe
  Rumpf wie die Kundenliste, eine Kennung je Absicht); der neue Kunde ist sofort in der Maske gewählt. Das gilt für
  jede Maske mit dieser Schnellanlage.
- **Our Price > 0:** Die Anlegemaske machte aus 0 und einem leeren Feld „kein Preis" und sperrte den Knopf; der
  Fernbefehl verlangte > 0 seit C3F, beim Anlegen und Ändern. Ein negativer Wert ging nur durch, weil nichts prüfte.
  Beim Modell „split" ist Our Price der Boden: ein Boden ≤ 0 macht den Abrechnungsbetrag ≤ 0, und daraus wird keine
  Rechnung. Neu ist nur, dass auch „Edit" am Primary 0 und negative Werte abweist.
- **Bestand:** Nur ein Stück im Lager (`in_stock`) geht hinaus — die Artikelliste der Maske zeigte nie etwas anderes,
  der Fernbefehl prüfte Lager und „schon draußen" seit C3F, ein Test hielt es fest. Liste und Prüfung fragen jetzt
  dieselbe Regel (`isTransferableStock`). Keine neue Geschäftsregel.
- **Anteil 0–100 %:** Die Maske begrenzte schon immer auf 0–100 (ohne Eingabe 50), das Haus speicherte ohne weitere
  Grenze; beide Ränder sind Fachfälle (0 %: der Kunde behält den Überschuss, 100 %: das Haus). Nur der Fernbefehl wich
  ab (1–99, mit Verweis auf die Kommission) — kein Test hielt das fest. Primary und fern: dieselbe Regel.

```
Unit  r5d/transfer-parity 248/0 (dazu die drei Verträge gegen 27768c0, Detailseite, Schnellanlage)
E2E   r5d1-transfer-entrypoints 50/0 (Detailseite Edit/Sold/Sold unter Preis/Return, „+ New Client" mit verlorener Antwort, Primary == PC2)
Registry 107 · Matrix 30 / 0 / 8 / 2
```

## R5E — Auftrag anlegen, Auftrag ändern, Einkauf anlegen (12.09.2026)

### Befund

- **Auftrag anlegen:** die Maske („New Order") baute den Auftrag in der React-Komponente — Produktzeilen mit Steuerschema
  (Auto = das des Artikels), NEUE Artikel, die Angebotszeile eines Sonderauftrags (brutto, mit Steuerwahl), Kostenzeilen
  (Goldschmied-Arbeit, Extra-Gold, Diamanten/Steine), Kundenmaterial, Final-Product-Spec mit Foto, Kopffelder, Summe und
  sichtbare Steuer — und legte DANACH, getrennt und mit verschlucktem Fehler, die **Gold-Verbindlichkeit** an: Extra-Gold,
  das der Goldschmied stellt, als Schuld in Gramm und Karat beim Goldschmied (`gold_payables`, `we_owe`, `OPEN`),
  verknüpft mit der Extra-Gold-Kostenzeile (die selbst KEINEN Lieferanten trägt, sonst stünde dasselbe Geld doppelt
  offen); aufgelöst wird sie später auf der Auftragsseite in Gold oder Geld. Der Fernbefehl kannte nur den normalen
  Auftrag mit bestehenden Artikeln und wies eine Anzahlung über der Summe ab, die der Primary als Guthaben bucht.
- **Auftrag ändern:** „Save" schreibt sechs Eingaben (Preis, Anzahlung, Lieferant, Einkauf, Liefertermin, Notiz) und leitet
  Marge (Preis − Einkauf) und Rest (Preis − Anzahlung) ab. Beim Sonderauftrag trägt die ANGEBOTSZEILE den Preis: ihr Preis
  wird gezogen, der Kopfpreis folgt aus den Zeilen. Der Fernbefehl lehnte den Sonderauftrag ab.
- **Einkauf anlegen:** die Maske legt in einer Zeile NEUE Artikel an (Maske „New Item" mit Foto), nennt den Mitarbeiter, kommt
  aus einem Auftrag (Wareneingang: dessen Positionen gehen auf „Arrived") oder aus einem Inbox-Foto (danach „erledigt" —
  getrennt geschrieben). Der Fernbefehl kannte nur bestehende Artikel.

### Lösung — die Maske schickt Eingaben, EINE Vorbereitung leitet ab

- `core/orders/order-create` (rein): Werte der Maske als Listen (Auftragsart, Anfangsstatus, Zahlweg, Schemata, Karat),
  `validateOrderCreate` (die Sätze der Maske), `planOrderCreate` (Zeilen, Summe, Steuer, Kopf, Kundenmaterial,
  Verbindlichkeit). `core/orders/order-edit`: `planOrderEdit`. `core/purchases/purchase-create`: `planPurchaseCreate`.
  `core/products/embedded-product`: EINE Feldliste und EINE Prüfung (Pflichtfelder, SKU-Riegel) für neue Artikel in
  Auftrag und Einkauf.
- `core/orders/order-house`, `core/purchases/purchase-house`: die Folge für den Fernbefehl (in seiner Transaktion) und für
  die Maske des Primary (`core/data/primary-action`: exklusiv, EINE Transaktion, danach durabel). Fotos reisen über die
  vorhandene Zwischenablage; im Auftrag stehen nur ihre Kennungen.
- Erweitert, nicht neu: `orders.create`, `orders.update`, `purchases.create`.

### Verträge des Primary, die sich ändern

| Punkt | vor R5E | R5E |
|---|---|---|
| Gold-Verbindlichkeit | nach dem Auftrag, Fehler verschluckt | in derselben Transaktion — ohne sie kein Auftrag |
| Anlegen / Ändern / Einkauf | mehrere Schreibvorgänge ohne Klammer | EINE Transaktion |
| Inbox-Foto „erledigt" | getrennt nach dem Einkauf | im selben Vorgang |
| Beträge beim Ändern | negative Eingaben möglich | ≥ 0 (der Vertrag des Fernbefehls seit C3E) |
| Beträge beim Anlegen | negative Eingaben möglich | ≥ 0 auf beiden Wegen (R5E FINAL, siehe unten) |
| „Edit" am abgeschlossenen/stornierten Auftrag | Maske bot es nicht an, Store/Fern ohne Sperre | `ORDER_NOT_EDITABLE` am Ändern-Weg |
| Neuer Artikel | Maske prüfte (Pflichtfelder, SKU) | dieselbe Prüfung zusätzlich am Haus |
| Fern: Anzahlung über der Summe | abgewiesen | wie der Primary: Guthaben |

```
Unit  r5e/order-purchase-parity 164/0 (lokal == fern inkl. Buchungen und Verbindlichkeit, Fehlerinjektion an acht Stellen, Autorität)
E2E   r5e-order-purchase-parity 73/0 (normal + neuer Artikel, Sonderanfertigung mit Gold-Verbindlichkeit, Ändern inkl. Angebotszeile, Einkauf mit neuem Artikel, Wareneingang, verlorene Antworten, Primary == PC2)
Registry 107 · Matrix 33 / 0 / 5 / 2
```

### R5E FINAL — die Verträge gegen den Stand vor R5E (`54ea905`)

**Vorzeichen.** Jedes Feld, das R5E als ≥ 0 prüft — mit dem Stand davor:

| Feld | Bedeutung | vor R5E | negativ fachlich? | was ein negativer Wert bewirkt hätte |
|---|---|---|---|---|
| Ändern `agreedPrice` | Verkaufspreis | Maske `Number(v) \|\| undefined`, ohne Vorzeichen; fern ≥ 0 seit C3E | nein | Rest und Marge verzerrt, negativer Preis in Umwandlung/Rechnung |
| Ändern `depositAmount` | Anzahlung laut Kopf | Maske `Number(v) \|\| 0`; fern ≥ 0 | nein — Erstattung läuft über Zahlungen | Rest > Preis |
| Ändern `supplierPrice` | erwarteter Einkauf | Maske `Number(v) \|\| undefined`; fern ≥ 0 | nein | Marge > Preis |
| Anlegen `quotedPrice` | Angebot brutto | `parseFloat \|\| 0`, keine Vorzeichenprüfung; fern: Feld gab es nicht | nein | gemischter Auftrag: Summe sinkt OHNE Zeile (versteckter Nachlass, Rechnung ≠ Auftrag) |
| Anlegen `customerGoldGrams` | Kundengold | wie oben | nein | ohne Wirkung (gelesen wird nur > 0) |
| Anlegen `laborCost` | Goldschmied-Arbeit | wie oben | nein | Kopf `labor_cost` negativ, keine Zeile |
| Anlegen `extraGoldGrams` | Extra-Gold in Gramm | wie oben | nein | keine Zeile, keine Verbindlichkeit — Eingabe verloren |
| Anlegen `extraGoldCost` | Wert des Extra-Golds | wie oben (mit Gramm > 0 schon abgewiesen) | nein | Kopf `extra_gold_value` negativ |
| Anlegen `depositAmount` | Anzahlung | `parseFloat \|\| 0`; fern ≥ 0 seit C3E | nein | keine Zahlung, Rest > Summe |
| Anlegen Zeile `unitPrice` | Preis je Stück | Zeichenfilter lässt kein Minus zu; fern ≥ 0 seit C3E | nein | — (unverändert) |
| Anlegen Material `totalCost` | Kosten Diamant/Stein/Gold | AddMaterialModal verlangt > 0 | nein | — (unverändert) |

Negative Werte rutschten nur mangels Prüfung durch; kein Gutschrift- oder Korrekturfall hängt an ihnen. Der
eine legitime Überschuss — Anzahlung über der Summe → Guthaben (`reconcileOrderOverpayCredit`) — bleibt, jetzt auch
fern. Nachlass, Erstattung, Lieferantengutschrift und Goldausgleich haben eigene Wege. **Befund:** beim Anlegen prüfte
R5E die Bereiche nur im Fernbefehl; R5E FINAL ruft `assertOrderCreateValues` in `planOrderCreate` — dieselbe Prüfung
auf beiden Wegen.

**Abgeschlossen / storniert.** Vor R5E zeigte die Auftragsseite „Edit" — den einzigen Einstieg in die sechs Felder —
nur bei `!isCancelled && !isCompleted` (ebenso „Cancel Order"). `updateOrder` im Store hat keine Sperre, weil er der
allgemeine Setzer für Status, Zahlung und Umwandlung ist. Der C3E-Fernbefehl hatte ebenfalls keine, war aber an keine
Maske angeschlossen (Matrix: Klasse B). Storniert ist schon Domänenregel („a cancelled order takes no further action");
abgeschlossen ist der Endzustand der Statusfolge und führt zur Rechnung. Also eine **bestehende Invariante** der einzigen
Oberfläche: an einem solchen Auftrag war über die Maske kein Feld änderbar. R5E hält sie zentral, und zwar nur am
Ändern-Weg (`updateOrderInHouse`), nicht im Store — Zeilen, Zahlungen, Goldausgleich und Umwandlung behalten ihre Regeln.

**Gold-Verbindlichkeit.** Sie entsteht aus der Extra-Gold-Kostenzeile (`materialKind 'gold'`, „Extra Gold …"), und nur,
wenn `extraGoldSupplierId` gesetzt und `extraGoldGrams > 0` ist. Gramm und Karat sind `extraGoldGrams`/`extraGoldKarat`
der Maske. Gläubiger ist der Lieferant des Extra-Golds (Goldschmied): `we_owe`, `return_gold`, `OPEN`. Die Zeile trägt
keinen Lieferanten, weil `commitOrderLineExpenses` nur Zeilen mit `supplier_id` als Geld-A/P bucht — sonst stünde
dieselbe Schuld in Geld und in Gramm offen. Geld entsteht erst bei `convertGoldPayableToMoney`, als eine Ausgabe an den
Goldschmied. Dieselbe Zeile finden:
- die Auftragsseite (`sourceOrderId`) und die Lieferantenseite (`supplierId`);
- `settleGoldReturn` und `convertGoldPayableToMoney` (Kennung);
- das Löschen der Zeile (`source_order_line_id`).

Einzige Änderung durch R5E: dieselbe Transaktion statt verschlucktem Fehler.

**Test-Delta `test/bridge/commercial-documents`.**

| früher abgewiesen | warum damals | warum jetzt Eingabe | was der Server weiter prüft |
|---|---|---|---|
| Einkauf: neues Produkt | zweiter Entstehungsweg neben `products.create` | Maske „New Item" | Feldliste (kein Einstand, Bestand, Los, keine Bildbytes), Kategorie, Pflichtfelder, SKU-Riegel; Los/Menge/Status rechnet `createPurchase` |
| Einkauf: Auftragsverknüpfung | Wareneingang als eigener Vorgang | Maske „aus Auftrag" | Auftrag der Filiale, Position genau dieses Auftrags (`ORDER_LINE_NOT_ON_ORDER`); „Arrived" setzt das Haus |
| Auftrag: Anfangsstatus | nur der normale Auftrag | Karte „6 · STATUS" (pending/arrived/notified/completed) | `cancelled` bleibt abgewiesen |
| Auftrag: Sonderanfertigung | Doppelvertrag der Angebotszeile | ganzer Sonderauftrag über eine Vorbereitung | Spec-Feldliste (kein Einstand), Kategorie, Bezeichner; Angebotszeile, Steuer und Summe leitet das Haus ab |
| Auftrag: neues Produkt | — | Maske | kein Bestand am Entwurf |
| Ändern: Sonderauftrag (`ORDER_NOT_NORMAL`) | Angebotszeile fern nicht bedient | die Zeile wird wie am Primary gezogen | Filiale, Fassung, `ORDER_NOT_EDITABLE`, `QUOTE_LINE_INVOICED`; Marge/Rest nie im Rumpf |
| Anzahlung über der Summe (`DEPOSIT_EXCEEDS_TOTAL`) | fern strenger als der Primary | der Primary bucht den Überschuss als Guthaben | Betrag ≥ 0, Zahlweg Pflicht; das Guthaben rechnet das Haus |

- Nichts ist übersprungen.
- Keine Absage wurde gestrichen: Summe, Rest, Marge, Typ, Rechnung, Steuer, Goldwert, Gold-Verbindlichkeit, bezahlter Betrag und Vorsteuer bleiben abgewiesen.
- Filial- und Fassungsprüfung sind unverändert.
- `PAYMENT_EXCEEDS_TOTAL`, `SUPPLIER_NOT_FOUND` und `PRODUCT_NOT_FOUND` des Einkaufs leben jetzt in `planPurchaseCreate`, auf beiden Wegen.
- Die Notiz kommt ungetrimmt an, wie aus der Maske.

**Neue Fern-Schreiblücke: „+ New Supplier" im Einkauf** (`CENTRAL_UI_R5E_NEW_SUPPLIER_WRITE_GAP_RECORDED`). Die
Einkaufsmaske legt über „+ New Supplier" am Primary lokal einen Lieferanten an (`createSupplier`). Der datenbanklose PC2
kann das nicht, denn es gibt keine Buchung `suppliers.create`. Die Lücke zählt nicht unter den 40 und ändert die Registry
nicht; umgesetzt wird sie jetzt nicht. Auf PC2 bleibt: einen bestehenden Lieferanten wählen oder ihn am Primary anlegen.

```
Pins  r5e/order-contract-pins 70/0 (Vorzeichen 8 + 3 Felder auf beiden Wegen, Guthaben bleibt, Terminal-Sperre, Gold, Delta, Lücke)
Unit  r5e/order-purchase-parity 164/0 (nach der Prüfungsverschiebung neu gelaufen) · commercial-documents 239/0
Registry 107 · Matrix 33 / 0 / 5 / 2 · keine neue Buchung
```

## R5F — Retoure anlegen, Kommission verkaufen und auszahlen (12.09.2026) · **BLOCKED (3 von 5 geschlossen) → in R5F.1 eingeordnet**

### Befund

- **Retoure anlegen:** die Maske („Return from Customer") schickt Zeile + Menge, Weg, eine von FÜNF Warenfolgen
  (auch „Under Repair"; „Return to Owner"/„Keep" nur, wenn Kommissionsware zurückkommt), Grund, Notiz und den
  Mitarbeiter. Bei „Refund jetzt zahlen" — und bei Store-Guthaben IMMER — lief danach, getrennt, `refundReturn`:
  Genehmigung mit Gutschrift, Deckel auf den bar erstattbaren Überschuss, Auszahlung, Buchung. Der Fernbefehl
  kannte weder Mitarbeiter noch „Under Repair" noch das sofortige Erstatten.
- **Freigabe und Erstattung** (`approveReturn`, `refundReturn`) ruft die Maske nur an zwei Stellen: im Anlegen mit
  Sofort-Erstattung (jetzt `returns.create`) und im **Rechnungsstorno** (`handleCancelInvoice`: Retoure + Freigabe +
  Erstattung + Status `CANCELLED`, ohne Zahlung stattdessen die Bestandsfreigabe). Einen eigenen Knopf gibt es nicht.
- **Kommissionsverkauf:** Detailseite (mit Nummerndialog, `specialMark` → Kreis der Rechnung) und Liste (ohne Dialog,
  normaler Kreis). Einkauf beim Einlieferer, Rechnung, ggf. Verlust-Ausgabe, Status und Menge ohne Klammer.
- **Auszahlung:** die Masken (Detail und Liste, „Pay Out (legacy)" nur ohne Rechnung) zahlten den OFFENEN Rest
  (`markPaidOut`). Fern: nur ein Teilbetrag, still gedeckelt, eine andere Wegeliste — und auch MIT Rechnung, wo der
  Einkauf beim Einlieferer die Schuld schon trägt (doppelte Auszahlung).
- In allen drei Folgen wurde ein gescheiterter Buchungsposten abgefangen und nur protokolliert: die Handlung stand
  ohne ihre Buchung.

### Lösung — die Maske schickt Eingaben, EINE Folge rechnet

- `core/returns/return-create` (rein: Listen der Maske, `returnCreateInput`, Rumpf) und `return-house`
  (`createReturnInHouse`/`createReturnOnPrimary`): Preis und Steuer aus der Rechnungszeile, dann `createReturn` und
  bei „sofort" `refundReturn` des Stores — in EINER Transaktion.
- `core/consignment/consignment-finance` (rein: Wegeliste, offener Rest, Rümpfe) und `consignment-finance-house`
  (`recordConsignmentSaleInHouse`, `payOutConsignmentInHouse`, je `…OnPrimary`): `recordSale` bzw.
  `recordPartialPayout` des Stores, je EINE Transaktion. Detail UND Liste laufen darüber.
- `postEntries` zählt Fehlschläge; `watchLedgerPosts` lässt jede der drei Folgen scheitern, wenn darin ein Posten
  scheiterte — auch ein abgefangener. Die ganze Handlung fällt zurück.
- Erweitert, nicht neu: `returns.create` (+ `staffId`, `refundNow`, „Under Repair"), `consignments.record_sale`
  (+ `specialMark`), `consignments.record_payout` (Wege der Maske + `bank`, Regeln der Folge).

### Verträge, die sich ändern

| Punkt | vor R5F | R5F |
|---|---|---|
| Retoure + Sofort-Erstattung | zwei Schreibvorgänge | EINE Transaktion, fern EINE Buchung |
| Retoure: Mitarbeiter | fern unbekannt | aktiv, diese Filiale (`EMPLOYEE_NOT_FOUND`) |
| Retoure: Grund/Notiz fern | getrimmt | wie getippt |
| Retoure: Rechnungsstatus | fern alles außer storniert | endgültig oder teilbezahlt (wie „Create Return") |
| Retoure: „Return to Owner"/„Keep" | ohne Prüfung | nur mit Kommissionsware (`DISPOSITION_NOT_ALLOWED`) |
| Retoure: dieselbe Zeile zweimal | umging den Mengendeckel | `INVALID_INPUT` |
| Retoure: Zeile mit Menge 0 | wurde mitgeschrieben | zählt als nicht gewählt |
| Verkauf: Nummernkreis fern | immer normal | Wahl des Nummerndialogs |
| Verkauf / Auszahlung am Primary | ohne Klammer | EINE Transaktion |
| Auszahlung mit Rechnung (fern) | zahlte zusätzlich zum Einkauf | `PAYOUT_VIA_PURCHASE` |
| Auszahlung über dem offenen Rest | still gedeckelt | `PAYOUT_EXCEEDS_OPEN` |
| Auszahlung am Primary | `markPaidOut` (setzt „paid") | dieselbe Folge: ein Teil bleibt „sold", erst null schließt |
| Abgefangener Buchungsfehler | Handlung ohne Buchung | ganze Handlung zurück |

### STOPP vor der Registry: `returns.approve` / `returns.refund`

Ihr einziger eigener Einstieg ist der Rechnungsstorno. Er setzt den Status `CANCELLED`. Dazu gehören
Ledger-Storno, Rückbuchung der Zahlungen, Guthaben-Sperren und die Entkopplung von Angebot und Auftrag. Keine der
40 Buchungen setzt diesen Status (`invoices.update` ändert Zeilen mit Grund). Freigabe oder Erstattung allein
wären ein Bruchteil des Vorgangs. Zu schließen ist das nur mit einer **neuen** Buchung (`invoices.cancel`), also nicht
in R5F. Der Storno bleibt am Primary.

Nebenbefund für diesen Schnitt: er verschluckt Fehler der Erstattung und storniert trotzdem, nimmt je Zeile 1 Stück
und den Nettopreis. Ein weiterer, kleiner Befund aus dem Zwei-App-Lauf: „Create Return" setzt beim Öffnen den
Mitarbeiter nicht zurück, eine zweite Retoure auf derselben Seite erbt den vorigen (auf beiden Rechnern gleich).
Er ist nicht behoben. Ebenfalls ohne Fernbuchung und außerhalb der 40 bleiben „Post-Sale Return" und „Cancel Sale"
der Kommission.

### Test-Delta (alte Pins, bewusst geändert)

- `lifecycle-actions`: der Nummernkreis ist eine Eingabe (vorher „kein Feld"); die Kette Verkauf-mit-Rechnung →
  Auszahlung ist jetzt `PAYOUT_VIA_PURCHASE` (vorher zahlte sie doppelt); REUSE nennt die geteilte Folge.
- `financial-actions`: mehr als offen ist ein Nein (vorher gedeckelt), der genaue Rest schließt.
- `return-chain`: REUSE/SHARED zeigen auf die geteilte Folge statt auf Bridge bzw. Bildschirm.
- `r4c1-role-parity` 36/0/2/2; die Matrix-Pins von R5D/R5E prüfen jetzt „fällt nicht zurück" statt eines festen Stands
  (der R5D-Pin stand seit R5E still auf 30/0/8/2).

```
Unit  r5f/returns-consignment-parity 173/0 (lokal == fern, Fehlerinjektion an 11 Stellen × 2 Wege, Autorität)
E2E   r5f-returns-consignment-finance 62/0 (Retoure später + sofort, Verkauf im Sonderkreis, Auszahlung des Rests, je Primary == PC2, drei verlorene Antworten, kein lokaler Schreibgriff)
Nachbarn return-chain 77/0 · lifecycle-actions 203/0 · financial-actions 190/0 · c4-authorization 169/0 · r5e 164/0 + 70/0 · r5d 248/0 · Matrix-Gate 458/0 · Rollen 35/0
Registry 107 · Matrix 36 / 0 / 2 / 2 · keine neue Buchung
```

## R5F.1 — der Rechnungsstorno als Buchung, die letzte Einordnung der Retoure (12.09.2026)

### Klassifikation: Freigabe und Erstattung haben keinen eigenen Knopf

Vor R5F (`0e522bf`) standen `approveReturn`/`refundReturn` in der Oberfläche nur an zwei Stellen:

- im Storno (`handleCancelInvoice`);
- im Sofort-Erstatten beim Anlegen einer Retoure.

Heute ruft sie keine Seite und keine Komponente mehr. Beide sind Teilwirkungen zweier Handlungen, und jede davon läuft
über EINE Folge: „Confirm Return & Refund" (`returns.create`) und „Cancel Invoice" (`invoices.cancel`). In der
Vierziger-Matrix stehen sie deshalb als **„ohne Handlung"**, nicht als verdrahtet. Die Buchungen selbst bleiben für
Fernaufträge bestehen. Matrix **36 / 0 / 0 / 4**; `invoices.cancel` steht daneben (`R5F1_NEUE_BUCHUNGEN`).

### Der Storno am Primary — Audit des Stands vor R5F.1

- **Knopf:** „Cancel" erscheint nur, wenn die Rechnung nicht storniert, nicht endgültig und nicht zurückgegeben ist
  (also teilbezahlt oder Entwurf), und nur mit `canEditInvoices`.
- **Mit erhaltenem Geld:** eine Retoure aller Zeilen — je Zeile **1 Stück zum Nettopreis** —, dann Freigabe und
  Erstattung im gewählten Weg (bar, Bank, Benefit). Ein Fehler darin wurde **verschluckt**, und storniert wurde trotzdem.
- **Ohne Geld:** je Zeile ein Stück zurück (`updateProduct`, „in_stock").
- **`updateInvoice(…CANCELLED)`, wenn keine Gutschrift existiert:** Lose zurück, Reservierung aufheben,
  Rechnungsbuchung stornieren, Zahlungen zurückbuchen. Dazu die Guthaben-Sperren (eingelöstes Überzahlungs- bzw.
  Änderungsguthaben blockt), Guthaben-Rückgabe und -Abräumung.
- **Mit Gutschrift:** Die Retoure hat bereits alles umgekehrt, deshalb kein zweiter Storno.
- **Immer:** Auto-Ausgaben (z. B. Kartengebühr) werden storniert und rückgebucht, Angebot und Auftrag entkoppelt.
- **Befund:** Der Dialog kündigt „Refund of <bezahlt>" an. Durch Nettopreis und 1 Stück je Zeile floss oft weniger
  zurück (Mengen über 1 blieben ganz liegen). Scheiterte die Erstattung, stand die Rechnung trotzdem auf CANCELLED.

### Entscheidung: EINE neue Buchung

`invoices.update` ändert Zeilen mit Begründung und kennt keinen Status. `returns.approve`/`returns.refund` wären nur
Bruchteile des Vorgangs. Deshalb gibt es genau eine neue Buchung, **`invoices.cancel`** (ausdrücklich freigegeben):

- Registry **108**, eingetragen in Rust (`REMOTE_OPS` und die Tests) und in `ALLOWED_MUTATIONS`, dort am Ende.
- Feste Feldliste `{ invoiceId, expectedRevision, refundMethod }`.
- Recht wie der Knopf (`canEditInvoices`).
- Die gesehene Fassung ist Pflicht; Nachweis und Idempotenz laufen über die Maschine; die Filiale kommt allein aus
  dem Ausweis.

### Lösung

- `core/invoices/invoice-cancel` (rein): `invoiceCancelBlocker` ist zugleich die Regel des Knopfs; dazu Wegeliste
  und Rumpf.
- `core/invoices/invoice-cancel-house`: EINE Folge in EINER Transaktion. Mit Geld: Retoure der **Restmengen zum
  Rechnungspreis** (`returnLineAmounts`), dann `approveReturn` und `refundReturn`. Ohne Geld: wie bisher. Danach
  `updateInvoice(…CANCELLED)`. Dialog des Primary und `invoices.cancel` rufen dieselbe Folge.
- Buchungswächter: auch `reverseSource`/`reverseTransaction` zählen Fehlschläge, denn sie schreiben direkt. Ein
  abgefangener Storno-Posten lässt die ganze Handlung zurückfallen.
- „Create Return" setzt beim Öffnen auch den Mitarbeiter auf „Unassigned" (wie jedes andere Feld).

### Verträge, die sich ändern

| Punkt | vor R5F.1 | R5F.1 |
|---|---|---|
| Storno mit Geld: Menge | je Zeile 1 Stück | Restmenge je Zeile |
| Storno mit Geld: Preis | netto | Rechnungspreis (brutto), wie jede Retoure |
| Storno: Erstattung | oft weniger als angekündigt | genau das Gezahlte, wie der Dialog sagt |
| Storno: Fehler der Erstattung | verschluckt, trotzdem CANCELLED | ganze Handlung zurück |
| Storno vom zweiten Rechner | nicht möglich | `invoices.cancel` |
| zweite Retoure auf derselben Seite | erbt den Mitarbeiter | beginnt bei „Unassigned" |

Die R5F-Verträge sind gegen `0e522bf` festgenagelt und sind alle Parität bzw. Fehlerbehebung, keine neue Regel:

- „Return to Owner"/„Keep" gab es nur mit Kommissionsware.
- Store-Guthaben wurde immer sofort erstattet.
- „Pay Out" gab es nur ohne Rechnung, und die Maske sandte nie einen Betrag.
- Ein Teilbetrag lässt „sold" stehen, erst der volle Betrag schließt.

```
Unit  r5f/invoice-cancel 94/0 (Klassifikation, Entscheidung, lokal == fern ×3, Regeln, Fehler an 6 Stellen × 2 Wege, Mitarbeiter, R5F-Pins)
E2E   r5f1-invoice-cancel 36/0 (Storno mit Geld und ohne, Primary == PC2, verlorene Antwort ohne zweite Erstattung/Buchung/Bestand, kein lokaler Schreibgriff; zwei Retouren auf derselben Seite: A mit, B ohne Mitarbeiter)
Registry-Pins angepasst (40→41 Buchungen, 107→108): c3g, c4 ×2, c2, c3b–c3f, c6, r3, r4b, r4c, r5c–r5f · Rust bridge 37/0
Registry 108 · Vierziger-Matrix 36 / 0 / 0 / 4 + invoices.cancel
```

### R5F FINAL GATE — Betrag, Teilzahlung, Storno-Wächter, Notiz, Registry

- **Betrag:** Eine Rechnung hat kein Rabattfeld. Ein angepasster Preis IST der Zeilenbetrag, und die Retoure rechnet
  daraus (`returnLineAmounts`), nicht aus Stückpreis × Menge. Gepinnt:
  - Menge 3 → Restmenge 3, genau 1000 mit anteiliger Steuer 90,909.
  - 1 von 3 schon zurück → Restmenge 2 (666,667); beide Retouren ergeben zusammen genau die Zeile.
  - Dialog „Refund of 400" = Erstattung 400 = Gutschrift bar 400 = Buchung (Erlös 909,091 + Steuer 90,909 zurück,
    Kasse −400, Forderung −600).
- **Echter Befund dabei:** Nach einem Storno blieb ein Gleitkomma-Rest (`399,9999999999999`). Eine frühere, offene
  Retoure konnte danach noch `5,7e-14` „erstatten" und meldete Erfolg. Die Beträge im Retourengeld
  (`computeRefundSplit`, `refundReturn`, `recordRefundPayment`) werden jetzt auf Fils (3 Stellen) gerundet. Danach
  zahlt die frühere Retoure nichts mehr aus (`NO_CASH_REFUNDABLE`).
- **Teilzahlung 500 von 1330:**
  - bar erstattet genau 500, kein Guthaben;
  - die Zahlung bleibt als Beleg;
  - jedes Konto steht danach bei null (Forderung, Kasse, Erlös, Steuer, Wareneinsatz, Bestand);
  - Soll = Haben, keine negative Restforderung.
- **Storno-Wächter:** `reverseSource`/`reverseTransaction` werfen wie bisher. Neu ist nur, dass ein gescheiterter
  Gegenposten gezählt wird — auch einer, den ein Aufrufer abfängt. Und zwar nur innerhalb des Fensters, das der Wächter
  beobachtet. Scheitert der ZWEITE Gegenposten, bleibt kein Teil-Storno und kein Erfolg. Danach gibt es genau einen
  Gegenposten je Buchung, und eine Wiederholung erzeugt keinen zweiten. Die legitimen Storno-Pfade bleiben grün
  (Gutschrift-Neubuchung, Rechnungsstorno, B2-Guthaben-Abbau).
- **Notiz:** Im Zwei-App-Vergleich wird nur die Rechnungsnummer des Zwillings zu `<INVOICE_NO>`; der Rest der Notiz
  (Retoure und Gutschrift) muss wortgleich sein.
- **Registry:** Vorher 40, jetzt 41 Buchungen, die einzige neue ist `invoices.cancel` (Rust: einzig
  `OP_INVOICES_CANCEL`, 107 → 108). Eine nicht freigegebene Buchung bleibt fail-closed. Die geänderten Zähl-Pins
  enthalten kein `skip`. Aus der Abweisungsliste ist nur `invoices.cancel` herausgenommen und positiv gepinnt; die
  Klasse-C-Probe prüft Löschen und Sondermarke der Rechnung weiter.

```
Unit  r5f/invoice-cancel 131/0 (+ §8 Betrag, §9 Teilzahlung, §10 Storno-Wächter, §11 Registry)
E2E   r5f1-invoice-cancel 36/0 auf neu gebauten Programmen (mit Fils-Rundung; Notiz nur mit normalisierter Rechnungsnummer verglichen)
Nachbarn return-chain 77/0 · invoice-lifecycle 136/0 · b2 credit-teardown 21/21 · c3h-stage 44/0 · r5f 173/0 · c4 ×2 · c3h-ui · c3a · r4c · r1
```

## R6A — die neue Schreiblücken-Inventur der gemeinsamen Oberfläche (12.09.2026)

Stand `8acf161`, Version 0.8.54, Registry **108** (unverändert), ursprüngliche 40er-Matrix **36 / 0 / 0 / 4**, dazu
`invoices.cancel` getrennt geführt. R6A ändert **keinen** Code, legt **keine** Buchung an und **verwendet keine alte
Matrix weiter**. Die 40er-Matrix (`_r4c-write-matrix.ts`) bleibt abgeschlossen. Die Tabelle unten ist ab jetzt die
eine Quelle für alles, was die gemeinsame Oberfläche schreibt, aber auf PC2 keinen gemeinsamen Schreibweg hat.

### Methode

Grundlage war kein Suchtreffer auf `getDatabase()`, sondern der Laufweg jeder Handlung:
`Knopf/Maske/Modal → Handler → Store/Service/Helfer → lokale Wirkung`.

- **Maschinelle Grundlage:** 156 schreibende Store-Aktionen und 47 Core-Module mit Schreibwirkung, dagegen gelesen
  alle 126 Dateien unter `pages/` und `components/`. 59 Dateien fassen Schreibendes an.
- **Handarbeit je Datei:** Knopf für Knopf geprüft. Dazu gehören Schreibwege über Rückruf-Props (SettleGoldModal,
  PayExpenseModal, PaySupplierModal, AddMaterialModal, CancelOrderModal, MessagePreviewModal) und die Bedingung
  im JSX um jeden Knopf.
- **PC2-Verhalten:** aus Code gelesen, nicht gefahren. `getDatabase()` wirft auf PC2. Wo das
  abgefangen wird, steht es in der Tabelle.
- **Zwei Behauptungen der Einzelprüfung sind widerlegt.** „Mehrfach-Auswahl stürzt ab“ und „Artikel löschen stürzt
  beim Öffnen ab“ stimmen nicht: `queryProductLinks` fängt den Fehler (`productStore.ts:312–328`). Die Knöpfe sind
  trotzdem tot. Auf PC2 wirken zudem alle Artikel unverknüpft, weil die Verknüpfungsprüfung dort still leer bleibt.

Kürzel für „PC2 heute“:

| Kürzel | Bedeutung |
|---|---|
| **TOT** | sichtbar; der Klick erreicht `getDatabase()` und scheitert (Ausnahme, Alert oder offenes Modal) |
| **NAC** | ehrliches Nein (`nichtAmClient`, `CLIENT_WRITE_UNSUPPORTED`) |
| **VERST** | auf PC2 nicht angezeigt |
| **NOTICE** | Route zeigt `PrimaryOnlyNotice` |
| **SCHEIN** | meldet Erfolg oder schweigt, ohne dass etwas beim Primary ankommt |
| **UNERR** | kein Nutzerpfad dorthin |

Kategorien:

| Kat. | Bedeutung |
|---|---|
| **A** | es fehlt eine Fernbuchung |
| **B** | Fernbuchung vorhanden, Oberfläche nicht angeschlossen |
| **C** | maschinenlokal |
| **D** | untätig oder unerreichbar |
| **E** | absichtlich nicht fern |

Löschen ist nach §5 **bewusst nie fern** (eigener Referenzvertrag) und steht deshalb unter E. Solange solche Knöpfe auf
PC2 sichtbar sind, sind sie trotzdem ein Oberflächenfehler.

### Zählung

```
Geprüfte Einstiege       231   (Werkzeug- und Einstellungs-Knöpfe je Panel gebündelt)
  angeschlossen           60   (40er-Matrix + invoices.cancel + Schnellanlage Kunde + Navigation)
  ohne gemeinsamen Weg   171
    A  95 Einstiege = 69 fachliche Schreibwege (neue Buchung nötig)
    B   8 Einstiege → 6 vorhandene Buchungen (keine Registry-Änderung)
    C  15   maschinenlokal
    D  12   unerreichbar/untätig
    E  41   absichtlich nicht fern (28 Löschknöpfe, 13 Werkzeug-/Einstellungs-Gruppen)
Registry 108 · Matrix 36/0/0/4 + invoices.cancel · keine neue Buchung
```

### Die vier bekannten Kandidaten, frisch geprüft

| Kandidat | Einstieg am Primary | Laufweg | Remote-Befehl? | Shared Write? | PC2 heute | Kat. |
|---|---|---|---|---|---|---|
| „+ New Supplier“ | `PurchaseCreate:391→845`, zusätzlich `RepairList:1008→1189` und `SupplierList:80` | `supplierStore.createSupplier` → INSERT `suppliers` | nein | nein | **TOT**; in `handleCreateSupplier` ungefangen | A |
| Inventursitzung | `WatchList:530` „Stock Check“ → `StockCheckInventoryModal` | Beginn: `ensureOpenSession`; Speichern: `recordStockCheck` (Tauri `create_stock_check`, **lokale** Konfig-DB) + `persistSessionItems`; Abschluss: `closeSession` | nein | nein | Beginn **SCHEIN** (kein Lauf, Fehler geschluckt). Speichern scheitert je Artikel (`PRODUCT_LOOKUP_UNAVAILABLE`). Liegt auf PC2 noch eine alte Geschäfts-DB, landet der Check in **PC2s eigener** `stock_checks` (zweite Wahrheit, PLAUSIBLE). Abschluss **SCHEIN** („finished“ ohne Wirkung) | A |
| Steuerzahlung | `AnalyticsPage:801` „Mark paid“ → `confirmTaxPayment` | roher INSERT `tax_payments` + `saveDatabase`; **keine** Hauptbuchbuchung, kein `trackInsert`, Fehler nur `console.warn` | nein | nein | **VERST** (`!readsFromPrimary()`), fail-closed | A |
| Nachbuchung | `/ledger-backfill` → `BackfillPage:169–188` (20 Knöpfe) | `backfillAll` / `backfill*` → `post*` | nein | nein | **NOTICE**; der Seitenleisten-Link bleibt sichtbar und führt zur Erklärung | E |

### Write-Gap-SSOT

Spalten: UI-Handlung | Ort (`src/…`) | Laufweg am Primary | PC2 heute | Kat. | vorhandene Buchung | nächster Schritt | Domäne · Risiko

**Verkauf · Rechnung · Angebot · Kunde**

| UI-Handlung | Ort | Laufweg am Primary | PC2 heute | Kat. | vorh. Buchung | nächster Schritt | Domäne · Risiko |
|---|---|---|---|---|---|---|---|
| Rechnung anlegen mit Zahlung > 0 | pages/invoices/InvoiceCreate:907 | createDirectInvoice + recordPayment | **angeschlossen (R6E)** | A | `invoices.create` (R6E) | **geschlossen (R6E)** | Verkauf/Geld · hoch |
| Rechnung ändern (Edit-Seite) | InvoiceCreate:907 (Edit-Modus) | invoiceStore.editInvoice (Zeilen, Kopf, Zahlungsdelta, Grund) | **angeschlossen (R6B)** | B | invoices.update (ohne Zahlungsdelta) | **geschlossen (R6B)** | Verkauf · mittel |
| Kopf speichern | pages/invoices/InvoiceDetail:649 | updateInvoice | UNERR (`editing` wird nie true) | D | — | toter Zweig | — |
| Status-Override | InvoiceDetail:766 | updateInvoice({status}) | UNERR | D | — | toter Zweig | — |
| Zeilen bearbeiten (Detail) | InvoiceDetail:784→1499 | editInvoice | UNERR | D | invoices.update | toter Zweig | — |
| Butterfly-Schalter | InvoiceDetail:657 | updateInvoice({butterfly}) | **angeschlossen (R6E)** | A | `invoices.set_butterfly` (R6E) | **geschlossen (R6E)** | Verkauf · niedrig |
| Schlusszahlung mit Sondernummer | InvoiceDetail:2095 | recordPayment(…, specialMark) | **angeschlossen (R6E)** | A | `invoices.record_payment` (R6E) | **geschlossen (R6E)** | Nummernkreis · hoch |
| „Mark as Picked Up“ | InvoiceDetail:669 | repairStore.updateStatus('picked_up') je Reparatur | **angeschlossen (R6B)** | B | repairs.update_status | **geschlossen (R6B)** | Reparatur · niedrig |
| Retoure stornieren | InvoiceDetail:1345→1858 | salesReturnStore.cancelReturn | **angeschlossen (R6E)** | A | `returns.cancel` (R6E) | **geschlossen (R6E)** | Retoure/Geld · hoch |
| Rechnung löschen | InvoiceDetail:697→1671 | invoiceStore.deleteInvoice | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| „Pay“ in der Rechnungsliste | pages/invoices/InvoiceList:430→514 | recordPayment | **angeschlossen (R6B)** | B | invoices.record_payment | **geschlossen (R6B)** | Geld · mittel |
| Nummernwahl nach „Pay“ | InvoiceList:595–604 | recordPayment(…, specialMark) | **angeschlossen (R6B)** | B | invoices.record_payment (nur Normalnummer) | **geschlossen (R6B)** | Nummernkreis · mittel |
| Gutschrift löschen | pages/credit-notes/CreditNoteDetail:103 | deleteCreditNote | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Angebot speichern | pages/offers/OfferDetail:220 | updateOffer | **angeschlossen (R6E)** | A | `offers.update` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Angebot senden | OfferDetail:227 | updateOffer({status:'sent'}) | **angeschlossen (R6E)** | A | `offers.set_status` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Angebot annehmen | OfferDetail:243 | updateOffer({status:'accepted'}) | **angeschlossen (R6E)** | A | `offers.set_status` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Angebot ablehnen | OfferDetail:244 | updateOffer({status:'rejected'}) | **angeschlossen (R6E)** | A | `offers.set_status` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Angebot → Rechnung | OfferDetail:248→520 | invoiceStore.createInvoiceFromOffer | **angeschlossen (R6E)** | A | `offers.convert_to_invoice` (R6E) | **geschlossen (R6E)** | Verkauf · hoch |
| Angebot löschen | OfferDetail:251→530 | deleteOffer | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Position hinzufügen | OfferDetail:281→541 | addOfferLine | **angeschlossen (R6E)** | A | `offers.update` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Positionspreis ändern | OfferDetail:349 | updateOfferLine (je Tastendruck) | **angeschlossen (R6E)** | A | `offers.update` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Position entfernen | OfferDetail:359 | removeOfferLine | **angeschlossen (R6E)** | A | `offers.update` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Angebot anlegen | pages/offers/OfferList:159→317 | createOffer | **angeschlossen (R6E)** | A | `offers.create` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Senden (Liste) | OfferList:201 | updateOffer | **angeschlossen (R6E)** | A | `offers.set_status` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Annehmen (Liste) | OfferList:206 | updateOffer | **angeschlossen (R6E)** | A | `offers.set_status` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Ablehnen (Liste) | OfferList:208 | updateOffer | **angeschlossen (R6E)** | A | `offers.set_status` (R6E) | **geschlossen (R6E)** | Angebot · mittel |
| Löschen (Liste) | OfferList:213 | deleteOffer | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Kunde löschen | pages/customers/CustomerDetail:588→1066 | deleteCustomer | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Kundengold zurückgeben | CustomerDetail:752→SettleGoldModal:288 | goldStore.returnCustomerCredit | **angeschlossen (R6D)** | A | `gold.customer_credits.settle` (R6D) | **geschlossen (R6D)** | Gold · hoch |
| Kundengold → BHD | CustomerDetail:756→SettleGoldModal:288 | convertCustomerCreditToMoney | **angeschlossen (R6D)** | A | `gold.customer_credits.settle` (R6D) | **geschlossen (R6D)** | Gold/Geld · hoch |
| Nachricht kopieren (Protokoll) | components/ai/MessagePreviewModal:218 | customerMessageStore.logMessage | **angeschlossen (R6E)** | A | `customers.log_message` (R6E) | **geschlossen (R6E)** | CRM · niedrig |
| WhatsApp (Protokoll) | MessagePreviewModal:221 | logMessage | **angeschlossen (R6E)** | A | `customers.log_message` (R6E) | **geschlossen (R6E)** | CRM · niedrig |
| Spotpreis aktualisieren | pages/dashboard/Dashboard:612 | getSpotPrices (localStorage) | geht | C | — | — | — |

**Artikel · Inventur · Einkauf · Lieferant**

| UI-Handlung | Ort | Laufweg am Primary | PC2 heute | Kat. | vorh. Buchung | nächster Schritt | Domäne · Risiko |
|---|---|---|---|---|---|---|---|
| Mehrfach löschen | pages/watches/WatchList:539→1232 | deleteProducts | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Etiketten drucken | WatchList:1266 | printRawZpl (Drucker am Platz) | geht | C | — | — | — |
| Artikel speichern mit Bildänderung | pages/watches/ProductDetail:515 (Zweig 417) | editProductWithMedia | **angeschlossen (R6F)** | A | `products.update` (R6F) | **geschlossen (R6F)** | Artikel/Medien · hoch |
| KI-Identifikation bestätigen | ProductDetail:856 | updateProduct({aiConfirmedAt}) | **angeschlossen (R6B)** | B | products.update (Feld fehlt in `PRODUCT_UPDATE_FIELDS`) | **geschlossen (R6B)** | Artikel · niedrig |
| Artikel löschen | ProductDetail:1519→1621 | deleteProduct | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Inventur öffnen (Lauf beginnen) | components/products/StockCheckInventoryModal:83–176 | ensureOpenSession + persistSessionItems | **angeschlossen (R6C)** | A | `inventory.start` (R6C) | **geschlossen (R6C)** | Inventur · hoch |
| Inventur speichern | StockCheckInventoryModal:471 | recordStockCheck (Tauri, lokale Konfig-DB) + persistSessionItems | **angeschlossen (R6C)** | A | `inventory.save` (R6C) | **geschlossen (R6C)** | Inventur · hoch |
| Inventur abschließen | StockCheckInventoryModal:503 | closeSession | **angeschlossen (R6C)** | A | `inventory.finish` (R6C) | **geschlossen (R6C)** | Inventur · hoch |
| Einzel-Check Verfügbar/Nicht | components/products/StockCheckPanel:119 (ProductDetail:1585) | recordStockCheck | **angeschlossen (R6C)** | A | `inventory.record_check` (R6C) | **geschlossen (R6C)** | Inventur · mittel |
| „+ New Supplier“ im Einkauf | pages/purchases/PurchaseCreate:391→845 | createSupplier | **angeschlossen (R6C)** | A | `suppliers.create` (R6C) | **geschlossen (R6C)** | Stammdaten · mittel |
| Einkauf: Zahlung erfassen | pages/purchases/PurchaseDetail:177→424 | purchaseStore.addPayment | **angeschlossen (R6D)** | A | `purchases.record_payment` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Einkauf: Guthaben verrechnen | PurchaseDetail:424 (credit) | getOpenCredits + applyCreditToPurchase (FIFO) | **angeschlossen (R6D)** | A | `purchases.apply_credit` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Rückgabe an Lieferant | PurchaseDetail:178→483 | createReturn + confirmReturn | **angeschlossen (R6F)** | A | `purchases.return_to_supplier` (R6F) | **geschlossen (R6F)** | Einkauf/Bestand · hoch |
| Einkauf stornieren | PurchaseDetail:183→496 | cancelPurchase | **angeschlossen (R6F)** | A | `purchases.cancel` (R6F) | **geschlossen (R6F)** | Einkauf/Buchung · hoch |
| Inbox-Foto verwerfen | pages/purchases/PurchaseList:115 | dismissPurchaseInbox | **angeschlossen (R6F)** | A | `purchases.dismiss_inbox` (R6F) | **geschlossen (R6F)** | Einkauf · niedrig |
| Lieferant anlegen | pages/suppliers/SupplierList:80→182 | createSupplier | **angeschlossen (R6C)** | A | `suppliers.create` (R6C) | **geschlossen (R6C)** | Stammdaten · mittel |
| Lieferant ändern | pages/suppliers/SupplierDetail:285→280 | updateSupplier | **angeschlossen (R6C)** | A | `suppliers.update` (R6C) | **geschlossen (R6C)** | Stammdaten · mittel |
| Lieferant (de)aktivieren | SupplierDetail:719 | updateSupplier({active}) | **angeschlossen (R6C)** | A | `suppliers.update` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Lieferant löschen | SupplierDetail:722→735 | deleteSupplier | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Lieferantenguthaben erstatten | SupplierDetail:696→760 | deleteStandaloneSupplierCredit | **angeschlossen (R6D)** | A | `suppliers.refund_credit` (R6D) | **geschlossen (R6D)** | Geld · mittel |
| „Pay Supplier — Bulk“ (Öffner) | SupplierDetail:425 → PaySupplierModal | siehe Finanzen | **angeschlossen (R6D)** | A | `suppliers.pay` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Werkstatt-Ausgabe zahlen (Öffner) | SupplierDetail:509 → PayExpenseModal | recordExpensePayment | **angeschlossen (R6D)** | A | `expenses.record_payment` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Gold zurück / Shop-Gold / → BHD | SupplierDetail:586/590/594 → SettleGoldModal | settleGoldReturn / applyShopGold… / convertGoldPayableToMoney | **angeschlossen (R6D)** | A | `gold.payables.settle` (R6D) | **geschlossen (R6D)** | Gold · hoch |
| Excel-Import | pages/settings/ImportPage:463 (`/import`, nicht gesperrt) | Vor-Sicherung + createProduct je Zeile | **NOTICE + Riegel (R6B)** | E | products.create (nur zeilenweise) | bleibt am Primary | Werkzeug · mittel |
| Dubletten-Guard bestätigen | components/sync/SyncDuplicateGuard:601 | mergeIntoExisting + updateProduct | UNERR (Ereignis nur aus dem im Client verweigerten Alt-Abgleich) | D | — | — | — |
| Dubletten-Guard übernehmen/ablehnen | SyncDuplicateGuard:586–598 | allocateSkuOnCreate + updateProduct | UNERR | D | — | — | — |
| Dubletten-Guard Hintergrund | SyncDuplicateGuard:247 | roher UPDATE `products` | UNERR | D | — | — | — |

**Auftrag · Reparatur · Produktion · Kommission · Agent · Metall · Schrott**

| UI-Handlung | Ort | Laufweg am Primary | PC2 heute | Kat. | vorh. Buchung | nächster Schritt | Domäne · Risiko |
|---|---|---|---|---|---|---|---|
| Auftrag stornieren (mit Geld) | pages/orders/OrderDetail:798→CancelOrderModal:198 | cancelOrderWithMoney (+ deleteOrder) | **angeschlossen (R6F)** | A | `orders.cancel` (R6F) | **geschlossen (R6F)** | Auftrag/Geld · hoch |
| Auftrag löschen | OrderDetail:1116→1880 | deleteOrder | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Zeilenstatus PENDING/ARRIVED/DELIVERED | OrderDetail:1207–1226 (ohne Rechteprüfung) | updateOrderLineStatus | **angeschlossen (R6F)** | A | `orders.update_line_status` (R6F) | **geschlossen (R6F)** | Auftrag · mittel |
| Zeilenstatus zurück | OrderDetail:1197 | updateOrderLineStatus | **angeschlossen (R6F)** | A | `orders.update_line_status` (R6F) | **geschlossen (R6F)** | Auftrag · mittel |
| Position bearbeiten | OrderDetail:1232→OrderLineEditModal:179 | updateOrderLine (legt ggf. Artikel an) | **angeschlossen (R6F)** | A | `orders.update_line` (R6F) | **geschlossen (R6F)** | Auftrag/Bestand · hoch |
| Beim Lieferanten bestellt | OrderDetail:1259→1760 | markOrderLineOrdered | **angeschlossen (R6F)** | A | `orders.mark_line_ordered` (R6F) | **geschlossen (R6F)** | Auftrag · mittel |
| Kostenposition hinzufügen | OrderDetail:1355→AddMaterialModal:528 | addOrderLine + createGoldPayable | **angeschlossen (R6D)** | A | `orders.add_cost` (R6D) | **geschlossen (R6D)** | Auftrag/Gold · hoch |
| Kostenposition löschen | OrderDetail:1438 | deleteOrderLine (storniert A/P) | **angeschlossen (R6D)** | A | `orders.remove_cost` (R6D) | **geschlossen (R6D)** | Auftrag/Buchung · hoch |
| A/P zahlen (Auftrag) | OrderDetail:1422→PayExpenseModal:60 | recordExpensePayment | **angeschlossen (R6D)** | A | `expenses.record_payment` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Shop-Gold geben | OrderDetail:1506→SettleGoldModal:288 | applyShopGoldToSupplierPayable / …CrossKarat… | **angeschlossen (R6D)** | A | `gold.payables.settle` (R6D) | **geschlossen (R6D)** | Gold · hoch |
| Gold → Geld (Auftrag) | OrderDetail:1511→SettleGoldModal:288 | convertGoldPayableToMoney | **angeschlossen (R6D)** | A | `gold.payables.settle` (R6D) | **geschlossen (R6D)** | Gold/Geld · hoch |
| Gold-Verbindlichkeit ✕ | OrderDetail:1516 | deleteGoldPayable | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| AI-Benachrichtigung (Protokoll) | OrderDetail:789→MessagePreviewModal | logMessage | **angeschlossen (R6E)** | A | `customers.log_message` (R6E) | **geschlossen (R6E)** | CRM · niedrig |
| „Pay“ in der Auftragsliste | pages/orders/OrderList:305→373 | orderPaymentStore.addPayment | **angeschlossen (R6B)** | B | orders.add_payment | **geschlossen (R6B)** | Geld · mittel |
| Material hinzufügen | pages/repairs/RepairDetail:1194→AddMaterialModal:528 | addRepairLine(Material) + createGoldPayable | **angeschlossen (R6D)** | A | `repairs.add_material` (R6D) | **geschlossen (R6D)** | Reparatur/Gold · hoch |
| A/P zahlen (Reparatur) | RepairDetail:1276→PayExpenseModal:60 | recordExpensePayment | **angeschlossen (R6D)** | A | `expenses.record_payment` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Goldverbrauch erfassen | RepairDetail:1333→1652 | createGoldPayable / createCustomerGoldCredit / creditShopGold | **angeschlossen (R6D)** | A | `repairs.record_gold_usage` (R6D) | **geschlossen (R6D)** | Gold · hoch |
| Werkstatt-Gold abrechnen | RepairDetail:1369→SettleGoldModal | settleGoldReturn | **angeschlossen (R6D)** | A | `gold.payables.settle` (R6D) | **geschlossen (R6D)** | Gold · hoch |
| Werkstatt-Gold → BHD | RepairDetail:1373→SettleGoldModal | convertGoldPayableToMoney | **angeschlossen (R6D)** | A | `gold.payables.settle` (R6D) | **geschlossen (R6D)** | Gold/Geld · hoch |
| Kundengold zurück (Reparatur) | RepairDetail:1406→SettleGoldModal | returnCustomerCredit | **angeschlossen (R6D)** | A | `gold.customer_credits.settle` (R6D) | **geschlossen (R6D)** | Gold · hoch |
| Kundengold → BHD (Reparatur) | RepairDetail:1410→SettleGoldModal | convertCustomerCreditToMoney | **angeschlossen (R6D)** | A | `gold.customer_credits.settle` (R6D) | **geschlossen (R6D)** | Gold/Geld · hoch |
| Reparatur löschen | RepairDetail:1163→1451 | deleteRepair | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| AI-Benachrichtigung (Reparatur) | RepairDetail:598→MessagePreviewModal | logMessage | **angeschlossen (R6E)** | A | `customers.log_message` (R6E) | **geschlossen (R6E)** | CRM · niedrig |
| „+ New Supplier“ (Werkstatt) | pages/repairs/RepairList:1008→1189 | createSupplier | **angeschlossen (R6C)** | A | `suppliers.create` (R6C) | **geschlossen (R6C)** | Stammdaten · mittel |
| Produktion anlegen | pages/production/ProductionPage:143→299 | productionStore.createRecord | **angeschlossen (R6F)** | A | `production.create` (R6F) | **geschlossen (R6F)** | Produktion/Bestand · hoch |
| Produktion löschen (Liste) | ProductionPage:369→332 | deleteRecord | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Produktion löschen (Detail) | pages/production/ProductionDetail:70→189 | deleteRecord | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Rückgabe nach Verkauf | pages/consignments/ConsignmentDetail:476/487→1004 | markReturnedAfterSale | **angeschlossen (R6F)** | A | `consignments.return_after_sale` (R6F) | **geschlossen (R6F)** | Kommission/Geld · hoch |
| Verkauf stornieren | ConsignmentDetail:478/483/491→1049 | cancelSale | **angeschlossen (R6F)** | A | `consignments.cancel_sale` (R6F) | **geschlossen (R6F)** | Kommission/Geld · hoch |
| Kommission löschen | ConsignmentDetail:500→1060 | deleteConsignment | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Rückgabe (Kommissionsliste) | pages/consignments/ConsignmentList:716 | markReturned | **angeschlossen (R6B)** | B | consignments.mark_returned | **geschlossen (R6B)** | Kommission · niedrig |
| Rückgabe (Kommittent) | pages/consignors/ConsignorDetail:258 | markReturned | **angeschlossen (R6B)** | B | consignments.mark_returned | **geschlossen (R6B)** | Kommission · niedrig |
| Agent ändern | pages/agents/AgentList:243→548 | updateAgent | **angeschlossen (R6C)** | A | `agents.update` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Agent löschen | AgentList:243→536 | deleteAgent | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Umwandlung rückgängig (Tabelle) | components/agents/TransferTable:455 | undoTransferInvoiceConvert (löscht Rechnung) | **angeschlossen (R6E)** | A | `transfers.undo_convert` (R6E) | **geschlossen (R6E)** | Transfer/Verkauf · hoch |
| Transfer löschen (Tabelle) | TransferTable:602 | deleteTransfer | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Umwandlung rückgängig (Detail) | pages/agents/TransferDetail:285 | undoTransferInvoiceConvert | **angeschlossen (R6E)** | A | `transfers.undo_convert` (R6E) | **geschlossen (R6E)** | Transfer/Verkauf · hoch |
| Transfer löschen (Detail) | TransferDetail:300→579 | deleteTransfer | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Metall anlegen | pages/metals/MetalList:181→514 | createMetal | **angeschlossen (R6D)** | A | `metals.create` (R6D) | **geschlossen (R6D)** | Metall/Bestand · mittel |
| Metall verkaufen | MetalList:344→547 | updateMetal | **angeschlossen (R6D)** | A | `metals.update_status` (R6D) | **geschlossen (R6D)** | Metall/Geld · mittel |
| Metall schmelzen | MetalList:349→570 | updateMetal | **angeschlossen (R6D)** | A | `metals.update_status` (R6D) | **geschlossen (R6D)** | Metall · mittel |
| Metall löschen | MetalList:356 | deleteMetal | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Spotpreis/g | MetalList:220 (je Tastendruck) | setSpotPrice (settings) | **angeschlossen (R6D)** | A | `metals.set_spot_price` (R6D) | **geschlossen (R6D)** | Filialeinstellung · niedrig |
| Schrotthandel anlegen | pages/scrap-trades/ScrapTradeNew → ScrapTradeForm:394 | createTrade | **angeschlossen (R6D)** | A | `scrap_trades.create` (R6D) | **geschlossen (R6D)** | Gold/Geld · hoch |
| Schrotthandel ändern | ScrapTradeDetail:58 → ScrapTradeForm:394 | updateTrade | **angeschlossen (R6D)** | A | `scrap_trades.update` (R6D) | **geschlossen (R6D)** | Gold/Geld · hoch |
| Schrotthandel stornieren | ScrapTradeDetail:59→85 | cancelTrade (Buchungsstorno) | **angeschlossen (R6D)** | A | `scrap_trades.cancel` (R6D) | **geschlossen (R6D)** | Buchung · hoch |
| Schrotthandel löschen | ScrapTradeDetail:63→101 | deleteTrade | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |

**Finanzen · Steuer · Buchhaltung**

| UI-Handlung | Ort | Laufweg am Primary | PC2 heute | Kat. | vorh. Buchung | nächster Schritt | Domäne · Risiko |
|---|---|---|---|---|---|---|---|
| Lieferant bezahlen (bar/Bank/Benefit) | components/expenses/PaySupplierModal:686 | FIFO: recordExpensePayment / purchaseStore.addPayment / grantStandaloneCredit | **angeschlossen (R6D)** | A | `suppliers.pay` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Lieferantenguthaben anwenden | PaySupplierModal:686 (Credit) | applySupplierCreditViaServer (Alt-B1-Protokoll über den Sync-Server) | **angeschlossen (R6D)** | A | `suppliers.apply_credit` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Ausgabe anlegen | pages/expenses/ExpenseList:661 | createExpense | **angeschlossen (R6D)** | A | `expenses.create` (R6D) | **geschlossen (R6D)** | Ausgaben · mittel |
| Wiederkehrende Ausgabe anlegen | ExpenseList:661 (Recurring) | recurringExpenseStore.createTemplate | **angeschlossen (R6D)** | A | `expenses.template_create` (R6D) | **geschlossen (R6D)** | Ausgaben · mittel |
| Vorlage pausieren/fortsetzen | ExpenseList:393 | setActive → updateTemplate + runDueGenerator | **angeschlossen (R6D)** | A | `expenses.template_update` (R6D) | **geschlossen (R6D)** | Ausgaben · niedrig |
| Vorlage speichern | ExpenseList:771 | updateTemplate | **angeschlossen (R6D)** | A | `expenses.template_update` (R6D) | **geschlossen (R6D)** | Ausgaben · niedrig |
| Vorlage löschen | ExpenseList:795 | deleteTemplate | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Ausgabe zahlen | ExpenseList:481→PayExpenseModal:139 | recordExpensePayment | **angeschlossen (R6D)** | A | `expenses.record_payment` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Ausgabe löschen (Liste) | ExpenseList:489→890 | deleteExpense (Storno + Guthaben zurück) | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Ausgabe löschen (Maske) | ExpenseList:853 | deleteExpense | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Ausgabe speichern | ExpenseList:861 | updateExpense | **angeschlossen (R6D)** | A | `expenses.update` (R6D) | **geschlossen (R6D)** | Ausgaben · mittel |
| Fällige Ausgaben erzeugen (beim Öffnen) | ExpenseList:123 | runDueGenerator | still, nichts | C | — | bleibt Sache des Primary | — |
| Umbuchung Kasse ↔ Bank | pages/banking/BankingPage:343 | bankingStore.createTransfer | **angeschlossen (R6D)** | A | `banking.transfer` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Partner anlegen | pages/partners/PartnersPage:187 | createPartner | **angeschlossen (R6C)** | A | `partners.create` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Einlage / Entnahme / Gewinnverteilung | PartnersPage:222 | recordInvestment / recordWithdrawal / recordProfitDistribution | **angeschlossen (R6D)** | A | `partners.record_tx` (R6D) | **geschlossen (R6D)** | Geld/Buchung · hoch |
| Partnerbewegung ✕ | PartnersPage:162 | deleteTransaction (+ Storno über safePost) | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Partner speichern | PartnersPage:279 | updatePartner | **angeschlossen (R6C)** | A | `partners.update` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Partner löschen | PartnersPage:267 | deletePartner | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Schuld anlegen | pages/debts/DebtsPage:674 | createDebt | **angeschlossen (R6D)** | A | `debts.create` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Rückzahlung erfassen | DebtsPage:757 | recordDebtPayment | **angeschlossen (R6D)** | A | `debts.record_payment` (R6D) | **geschlossen (R6D)** | Geld · hoch |
| Schuld speichern | DebtsPage:811 | updateDebt | **angeschlossen (R6D)** | A | `debts.update` (R6D) | **geschlossen (R6D)** | Geld · mittel |
| Schuld löschen | DebtsPage:763→842 | deleteDebt (Zahlungsstorno + Löschen) | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Steuerzahlung eintragen | pages/analytics/AnalyticsPage:801→1015 | roher INSERT `tax_payments` (ohne Buchung) | **angeschlossen (R6D)** | A | `tax.record_payment` (R6D) | **geschlossen (R6D)** | Steuer · hoch |
| „Storniere alle Orphans“ | pages/reports/ReconciliationPage:251 | hasReversalFor + reverseSource | VERST | E | — | bleibt am Primary | Buchhaltungsreparatur |
| Nachbuchung (20 Knöpfe) | pages/reports/BackfillPage:169–188 | backfillAll / backfill* | NOTICE | E | — | bleibt am Primary | Buchhaltungsreparatur |
| Hauptbuch-Prüfstand (≈43 Testknöpfe) | pages/settings/LedgerDebugPage:742–929 | post* / …Reversed | NOTICE | E | — | bleibt am Primary | Prüfstand |

**Personal · Büro · System**

| UI-Handlung | Ort | Laufweg am Primary | PC2 heute | Kat. | vorh. Buchung | nächster Schritt | Domäne · Risiko |
|---|---|---|---|---|---|---|---|
| Mitarbeiter anlegen | pages/employees/EmployeeList:257 | createEmployee | **angeschlossen (R6C)** | A | `employees.create` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Beurlauben/Reaktivieren (Liste) | EmployeeList:189/197 | updateEmployee | **angeschlossen (R6C)** | A | `employees.update` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Mitarbeiter löschen | EmployeeList:272 | deleteEmployee | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Beurlauben/Reaktivieren (Detail) | pages/employees/EmployeeDetail:152/156 | updateEmployee | **angeschlossen (R6C)** | A | `employees.update` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Mitarbeiter speichern | EmployeeDetail:700 | updateEmployee | **angeschlossen (R6C)** | A | `employees.update` (R6C) | **geschlossen (R6C)** | Stammdaten · niedrig |
| Aufgabe anlegen/ändern | pages/tasks/TaskList:313 | createTask / updateTask | **angeschlossen (R6F)** | A | `tasks.create` (R6F) + `tasks.update` | **geschlossen (R6F)** | Büro · niedrig |
| Aufgabe erledigt | TaskList:595 | completeTask | **angeschlossen (R6F)** | A | `tasks.update` (R6F) | **geschlossen (R6F)** | Büro · niedrig |
| Aufgabe löschen | TaskList:627 | deleteTask | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Dokument hochladen | pages/documents/DocumentList:358 | uploadDocument | **angeschlossen (R6F)** | A | `documents.upload` (R6F) | **geschlossen (R6F)** | Büro · niedrig |
| Dokument löschen | DocumentList:476 | deleteDocument | **gesperrt + erklärt (R6B)** | E | — | bleibt am Primary (§5) | Löschen |
| Texterkennung (OCR) | DocumentList:430 | extractOcr | **angeschlossen (R6F)** | A | `documents.set_ocr` (R6F) | **geschlossen (R6F)** | Büro · niedrig |
| **Abmelden** | components/layout/Sidebar:372 | authService.logout → `getDatabase` + DELETE `sessions` | **geht — lokal abgemeldet, zurück zur Anmeldung (R6B)** | C | — | erledigt (R6B) | Sitzung · hoch (Oberfläche) |
| Filiale wechseln | Sidebar:221 | switchBranch | VERST (eine Filiale) | C | — | — | — |
| Update installieren | components/shared/UpdateBanner:193 | prepareAndInstallUpdate (Flush ohne DB ist wirkungslos) | geht (aus Code gelesen) | C | — | — | — |
| Anmelden | components/startup/ClientShell:421 | clientLogin | geht | C | — | — | — |
| Trennen | ClientShell:153/431 | leaveClientMode | geht | C | — | — | — |
| Sprache, KI-Schlüssel/-Test (4) | pages/settings/SettingsPage:1468–1795 | localStorage / Datei | NOTICE | C | — | — | — |
| Sync, Server, Owner, Adopt, Scope (14) | SettingsPage:2089–2198 + Dialoge | Tauri | NOTICE | C | — | — | — |
| Update prüfen | SettingsPage:3455 | Ereignis | NOTICE | C | — | — | — |
| Purge / Werksreset (2) | SettingsPage:3230/3277 | Vor-Sicherung + Purge/Reset | NOTICE | C | — | — | — |
| Sicherung/Wiederherstellung (8) | pages/settings/BackupRestorePanel:216–376 | Tauri | NOTICE | C | — | — | — |
| Speicherwartung (3) | pages/settings/StorageMaintenancePanel:114–195 | Tauri | NOTICE | C | — | — | — |
| Datenort (3) | pages/settings/DataLocationPanel:125–149 | Tauri | NOTICE | C | — | — | — |
| Firma speichern | SettingsPage:192 | setSetting ×5 | NOTICE | E | — | bleibt am Primary | Hauskonfiguration |
| Steuer/Finanzen speichern | SettingsPage:490 | setSetting ×21 | NOTICE | E | — | bleibt am Primary | Hauskonfiguration |
| Kategorien (3) | SettingsPage:782/639/666 | createCategory / updateCategory | NOTICE | E | — | bleibt am Primary | Hauskonfiguration |
| Filialen (3) | SettingsPage:866/1050/1004 | db.run branches | NOTICE | E | — | bleibt am Primary | Hauskonfiguration |
| Benutzer (3) | SettingsPage:1306/1233/1258 | db.run users / user_branches | NOTICE | E | — | bleibt am Primary | Rechte |
| Nummernkreise | SettingsPage:1432 | db.run settings | NOTICE | E | — | bleibt am Primary | Hauskonfiguration |
| Ländervorwahlen (2) | SettingsPage:1687/1646 | country-codes-store.saveAll | NOTICE | E | — | bleibt am Primary | Hauskonfiguration |
| Dubletten zusammenführen/löschen (4) | SettingsPage:2691–3008 | updateProduct / mergeIntoExisting / deleteProduct | NOTICE | E | — | bleibt am Primary | Werkzeug |
| Reparatur-Prüfstand (2) | pages/admin/RepairFlowTestPage:1725/1728 | Testszenarien, Test-Purge | NOTICE | E | — | bleibt am Primary | Prüfstand |
| Alt-Bereich des Client-Fensters | components/startup/ClientShell:135–303 | client/*-Masken | UNERR (nur wenn ein gespeicherter Ausweis `sessionFromToken` nicht besteht) | D | (40er-Buchungen) | Rückbau prüfen | — |
| client/*-Masken (11 Dateien) | components/client/* | CommandSaveController | UNERR nach Anmeldung | D | (40er-Buchungen) | Rückbau prüfen | — |
| Erstlauf-Einrichtung | pages/auth/OnboardingPage:209 | db.run tenants/branches/users/settings | UNERR (`!clientMode`) | D | — | — | — |
| Anmelden (lokal) | pages/auth/LoginPage:73/127 | authService.login | UNERR | D | — | — | — |
| Datenbank zurücksetzen (Login) | LoginPage:146 | runGuardedReset | UNERR | D | — | — | — |
| Erstlauf: neu / Ordner übernehmen / verbinden | components/startup/FirstRunGate:125/236/268/197 | Tauri | UNERR im Client | D | — | — | — |

### Keine toten Knöpfe auf PC2 — der Stand (`CENTRAL_UI_R6A_PRIMARY_ONLY_UI_AUDITED`)

**Sauber, weil fail-closed:**
- Einstellungen, Nachbuchung, Hauptbuch-Prüfstand, Reparatur-Prüfstand, Reparatur-Abgleich: `PrimaryOnlyNotice`.
- Steuerzahlung, Orphan-Storno und Filialwechsel: auf PC2 nicht angezeigt.
- Rechnung ändern, Zahlung beim Anlegen, Sondernummer und Bildänderung: `nichtAmClient`.

**Nicht sauber (nur festgehalten, noch nicht geändert):**
1. **Abmelden ist auf PC2 unmöglich.** Der Klick wirft in `authService.logout`, bevor Sitzung und `lataif_session`
   geleert sind.
2. **28 Löschknöpfe (E) sind sichtbar und tot.** Rechnung, Gutschrift, Angebot ×2, Kunde, Artikel ×2, Lieferant,
   Auftrag, Gold-Verbindlichkeit, Reparatur, Produktion ×2, Kommission, Agent, Transfer ×2, Metall, Schrott,
   Ausgabe ×2, Vorlage, Partner, Partnerbewegung, Schuld, Mitarbeiter, Aufgabe, Dokument.
3. **`/import` ist nicht gesperrt.** Die Seite versucht auf PC2 eine lokale Vor-Sicherung und meldet dann
   „0 imported“.
4. **Schein-Erfolge:** „Inventur abschließen“ meldet „finished“ ohne Wirkung. „Inventur öffnen“ beginnt keinen Lauf,
   ohne es zu sagen. Das Nachrichtenprotokoll (Kopieren/WhatsApp) wird dreifach still verworfen.
5. **Stock-Check schreibt über den lokalen Tauri-Kern.** Er schreibt in die Konfig-DB des eigenen Rechners, nicht in
   die des Primary. Auf PC2 scheitert er meist an der fehlenden Geschäfts-DB. Liegt dort noch eine alte, entsteht
   eine zweite Wahrheit.
6. **Auf PC2 wirken alle Artikel „unverknüpft“.** Die Verknüpfungsprüfung bleibt still leer, und der anschließende
   Löschklick ist tot.
7. **Zufällig verborgen, nicht bewusst gesperrt:** Lieferantenguthaben erstatten und Lieferantenguthaben anwenden.

### Nebenbefunde am Primary (nur festgehalten, nicht Teil der Parität)

- **Steuerzahlung** (bestätigt): roher INSERT ohne Hauptbuchbuchung und ohne `trackInsert`. Ein Fehler endet nur in
  `console.warn`, das Modal schließt wie bei Erfolg.
- **PLAUSIBLE, aus der Einzelprüfung, nicht nachgefahren:**
  - `partnerStore.deleteTransaction` löscht vor dem Storno (über `safePost`), also nicht atomar.
  - `PaySupplierModal` rechnet den Rest ohne bereits verrechnetes Guthaben, und die Zahlschleife ist nicht atomar.
  - `applySupplierCreditViaServer` hängt am Alt-Sync-Server und dürfte auch am Primary „offline“ melden.

### Priorisierung — Scheiben nach Domänen (`CENTRAL_UI_R6A_NEW_WRITE_GAP_SSOT_READY`)

| Scheibe | Inhalt | Registry | Einstiege |
|---|---|---|---|
| **R6B — ehrlich machen + B anschließen** | 8 B-Einstiege auf 6 vorhandene Buchungen: `invoices.update` (Edit-Seite ohne Zahlungsdelta), `invoices.record_payment` ×2, `repairs.update_status`, `products.update` (Feld `aiConfirmedAt`), `orders.add_payment`, `consignments.mark_returned` ×2. Dazu fail-closed: Abmelden-Client-Zweig, 28 Löschknöpfe, `/import`, Inventur-Schein-Erfolge, Nachrichtenprotokoll ehrlich | **keine neue Buchung** | 8 B + UI |
| **R6C — Stammdaten und Schnellanlagen** | `suppliers.create` (drei Stellen inkl. „+ New Supplier“), `suppliers.update`/aktiv, `agents.update`, Partner-Stammdaten, Mitarbeiter, Aufgaben | neue Buchungen | 17 |
| **R6D — Inventur** | Inventurlauf beginnen/speichern/abschließen und Einzel-Check über den Primary (Konfig-DB des Primary statt der eigenen); Inbox-Foto verwerfen; Metallbestand | neue Buchungen | 10 |
| **R6E — Finanzen und Steuer** | Steuerzahlung (mit Buchung), Ausgaben + Vorlagen, A/P-Zahlung (PayExpenseModal an 4 Stellen), Lieferant bezahlen/Guthaben (Einkaufszahlung, Guthabenverrechnung, Erstattung), Kasse↔Bank, Schulden, Partnerbewegungen | neue Buchungen | 27 |
| **R6F — Gold und Buchungen** | Gold-Familie (zurückgeben, → BHD, Shop-Gold, Verbrauch; 12 Einstiege in Kunde/Lieferant/Auftrag/Reparatur), Kosten/Material mit Gold-Schuld, Schrotthandel | neue Buchungen | 19 |
| **R6G — übrige Lebenszyklen** | Angebote (12), Einkauf zurückgeben/stornieren, Auftrag stornieren + Zeilenwege, Kommission Rückgabe nach Verkauf/Verkauf stornieren, Transfer rückgängig, Produktion, Rechnung (anlegen + zahlen atomar, Sondernummer, Butterfly, Retoure stornieren), Bildänderung am Artikel (Medienweg), Dokumente/OCR, Nachrichtenprotokoll | neue Buchungen | 22 |

(Die Einstiegszahlen je Scheibe sind grob. Maßgeblich ist die Tabelle, in der jeder Einstieg genau einmal steht.)

`CENTRAL_UI_R6A_WRITE_ENTRYPOINT_AUDIT_COMPLETE`

## R6B — Sicherheit und die acht vorhandenen Buchungen (12.09.2026)

Grundlage ist die R6A-SSOT. Registry **108** (unverändert), keine neue Buchung. Die ursprüngliche 40er-Matrix bleibt
**36 / 0 / 0 / 4**, `invoices.cancel` getrennt. A-Lücken sind nicht nebenbei verändert: Die Tabelle oben trägt nur in
„PC2 heute" und „nächster Schritt" den neuen Stand.

### Umfang, eingefroren (`CENTRAL_UI_R6B_CATEGORY_B_SCOPE_FROZEN`)

Aus der R6A-SSOT gelesen, nicht aus der Erinnerung: acht Einstiege, sechs vorhandene Buchungen.

| Einstieg | Buchung | Anschluss |
|---|---|---|
| Rechnung ändern (Edit-Seite) | `invoices.update` | lokal `editInvoice` wie bisher; fern Rechnung, gesehene Fassung, Grund, Kunde, Zeilen (mit Los), Notiz, Datum, Mitarbeiter. Eine Zahlung im Ändern bleibt ein ehrliches Nein, weil sie eine eigene Buchung ist. |
| „Pay" in der Rechnungsliste | `invoices.record_payment` | derselbe Rumpf wie auf der Rechnungsseite (Rechnung, Betrag, Weg) |
| Nummernwahl nach „Pay" | `invoices.record_payment` | derselbe Anschluss (zweiter Einstieg); der Sonderkreis bleibt fern ein ehrliches Nein und fällt nie still in den Normalkreis |
| „Mark as Picked Up" | `repairs.update_status` | eine Buchung je Reparatur, jede mit ihrer Fassung |
| KI-Identifikation bestätigen | `products.update` | nur `{ id, aiConfirmedAt: true }` |
| „Pay" in der Auftragsliste | `orders.add_payment` | mit der gesehenen Fassung des Auftrags |
| Rückgabe (Kommissionsliste) | `consignments.mark_returned` | gemeinsamer Rumpf `consignmentReturnBody` |
| Rückgabe (Einlieferer) | `consignments.mark_returned` | derselbe Anschluss (zweiter Einstieg) |

### Primary zuerst — was am Primary falsch war, gemeinsam behoben (`CENTRAL_UI_R6B_PRIMARY_CONTRACTS_AUDITED`)

- **Abholen übersprang „ready".** Der Knopf auf der Rechnung setzte JEDE verbundene Reparatur auf `picked_up`, auch
  eine „in Arbeit". An „ready" hängen die Werkstatt-Forderung, die Kapitalisierung eigener Ware und die Marge
  (`repairStore.updateStatus` bucht nur beim Zielstatus). Jetzt gilt auf der Rechnungsseite dieselbe Regel wie auf
  der Reparaturseite und im Fernbefehl (`allowedRepairStatusTargets`). Eine Reparatur, die noch nicht fertig ist,
  bleibt stehen, und der Bestätigungsdialog nennt sie.
- **Das Rechnungsdatum hing am Rechner.** Beim Ändern gab die Maske `…T00:00:00.000Z`, der Fernauftrag
  `YYYY-MM-DD`, und `editInvoice` legte beides roh ab. Jetzt legt `issuedAtIso` (die Regel des Anlegens) auf beiden
  Wegen denselben Wert ab.
- **Rückgabe aus Liste und Einlieferer ohne Prüfung.** Der lokale Weg rief `markReturned` ohne Statusprüfung. Jetzt
  fragen alle drei Einstiege und der Fernbefehl dieselbe Funktion `consignmentReturnBlocker`: Zurück geht nur eine
  aktive, unverkaufte Kommission. `markReturnedAfterSale` bleibt unberührt.
- **KI-Bestätigung mit der Uhr des Rechners, ohne Prüfung.** Jetzt schreibt EINE Hausfunktion
  (`confirmAiIdentificationInHouse`):
  - Bestätigt wird nur, was die KI identifiziert hat.
  - Die Zeit stempelt der Primary.
  - Ein zweites Bestätigen ändert nichts.

  Keine Feldöffnung: `aiConfirmedAt` steht nicht in `PRODUCT_UPDATE_FIELDS`. Fern reist nur die Absicht `true`, und
  zwar allein — ein Zeitwert, ein Textfeld oder eine Galerie daneben werden abgewiesen.
- **Zahlungsfehler in den Listen verschwanden.** Der lokale Aufruf warf ungefangen. Jetzt steht der Grund in der
  Zahlmaske (`WriteError`).
- **Inventur am Primary, halber Erfolg.** Konnte das Arbeitsblatt nicht gespeichert werden, schloss die Maske trotzdem
  wie bei Erfolg und nahm die Warnung mit. Jetzt bleibt sie offen.
- **Nachrichtenprotokoll.** Ein gescheiterter Eintrag wurde verschwiegen; jetzt wird er gesagt.

### Sicherheit auf dem Rechner ohne Datenbank

- **Inventur und Stock-Check** (`CENTRAL_UI_R6B_INVENTORY_CLIENT_FAIL_CLOSED_PROVED`): Die eine Stelle ist
  `core/stock/stock-check.ts`. Auf dem Client ruft sie den Rust-Kern des eigenen Rechners gar nicht auf — kein
  Lesen, kein Schreiben. Das gilt ausdrücklich auch, wenn im Datenordner noch eine alte `lataif.db` liegt; dort wäre
  sonst eine zweite Wahrheit entstanden. Dazu:
  - Die Knöpfe sind gesperrt und erklärt.
  - Die Maske beginnt keinen Lauf.
  - „Inventur abschließen" meldet kein „finished" ohne Wirkung.
  - Der Einzel-Check zeigt einen Satz statt zweier Knöpfe.

  Der Weg über den Primary ist R6D.
- **Ländervorwahlen** (Telefonfeld, z. B. beim Bearbeiten eines Kunden): Der Zwei-Rechner-Lauf fand den Griff auf
  dem Client — `country-codes-store.load` fragte die lokale Einstellungstabelle (ins Leere, abgefangen). Jetzt gibt es
  keinen Griff mehr. Der Client zeigt wie bisher die eingebauten Vorwahlen; eigene Vorwahlen sind Hauskonfiguration
  am Primary, sie aus der Ferne zu lesen bleibt offen.
- **Import** (`CENTRAL_UI_R6B_IMPORT_CLIENT_FAIL_CLOSED_PROVED`): `/import` zeigt die Primary-Notiz,
  „Import Excel" ist gesperrt, und im Handler steht ein Riegel vor Sicherung und Anlegen.
- **Abmelden** (`CENTRAL_UI_R6B_CLIENT_LOGOUT_PROVED`): Auf dem Client ist `authService.logout` rein lokal — Sitzung
  und Ausweis weg, zurück zu Verbinden/Anmelden, die Serveradresse bleibt. Kein Datenbankgriff. Der Primary-Weg ist
  unverändert.
- **Kein Schein-Erfolg** (`CENTRAL_UI_R6B_NO_FALSE_SUCCESS_PROVED`):
  - Inventur wie oben.
  - Das Nachrichtenprotokoll sagt auf dem Client „nicht protokolliert", statt still zu verwerfen.
- **Die 28 Löschknöpfe** (`CENTRAL_UI_R6B_UNSUPPORTED_DELETES_FAIL_CLOSED`): Jeder ist auf dem Client gesperrt,
  erklärt und markiert (`primaryOnlyDeleteProps`), und jeder Handler hat den Riegel `blockDeleteOnClient`. Am Primary
  bleibt jeder Knopf, wie er war. Löschen bleibt nach §5 bewusst nie fern.

### Test-Delta (alte Pins, bewusst geändert)

- `r4b-write-adapter` §6, zwei Pins:
  - „Ändern einer Rechnung gesperrt" heißt jetzt: Ändern geht fern über `invoices.update`, nur eine Zahlung darin
    bleibt ein ehrliches Nein.
  - Der Pin „Zahlung beim Anlegen" folgt der neuen Bedingung `!isEditMode`.
- `stock-check.ts` importiert die Weiche als `../bridge/client-mode.ts`. So bleibt das Modul ohne Alias-Auflösung
  ladbar (`test/stock/stock-check.test.ts`).

**Vorbestehend rot, nicht R6B** — an `e33e950` in einem unberührten Arbeitsbaum nachgewiesen und nicht angefasst:

- `bridge/client-masterdata-ui` („the primary decides stockStatus")
- `bridge/command-scheduler` (Pin „genau diese vierzig", seit R5F.1 einundvierzig)

### Beweise

```
Unit  r6b/safety-existing-commands 97/0 (Umfang, Primary-Verträge, Inventur, Import, Abmelden, Schein-Erfolg, 28 Löschknöpfe, Registry)
E2E   r6b-safety-existing-commands 83/0 auf neu gebauten Programmen:
      acht B-Einstiege Primary == PC2, je genau EIN Auftrag
      Sonderkreis fern ehrlich abgewiesen
      Abholen ohne Stufensprung (auch am Primary)
      alte lataif.db im Datenordner des Clients unberührt, kein Stock-Check-Aufruf des lokalen Kerns
      kein Datenbankgriff, keine neue Datei, keine Warteschlange
      Abmelden → Anmeldung
Nachbarn r4b 140/0 · stock-check 32/0 · r5e-Pins 70/0 · lifecycle-actions 203/0 · return-chain 77/0 · r4a 15/0
      r5f · invoice-cancel · invoice-lifecycle · invoice-revision · product-remote-write · r4c · r4c1 · r2c-Scan · r2d (grün)
TS    tsconfig.app 0 · tsconfig.node 0 · Lint-Delta 0
Registry 108 · Matrix 36/0/0/4 + invoices.cancel · keine neue Buchung
```

### Stand der R6A-SSOT nach R6B

```
B   8 → 0 offen (alle angeschlossen)
A  95 unverändert (Inventur 4 + Protokoll 4 jetzt ehrlich gesperrt bzw. gesagt, Lücke bleibt A)
C  15 (Abmelden erledigt)   D 12   E 41 (28 Löschknöpfe gesperrt + erklärt, Import mit Notiz + Riegel)
Registry 108 · Matrix 36/0/0/4 + invoices.cancel · keine neue Buchung
```

Offen bleibt aus der R6A-Liste nur Punkt 7: zwei zufällig verborgene Guthaben-Aktionen. Sie sind A, und ihre Stelle ist
R6E. Die „unverknüpft"-Anzeige der Mehrfach-Auswahl (Punkt 6) ist mit dem gesperrten „Select" nicht mehr erreichbar.

## R6C — Stammdaten, Schnellanlagen und Inventur (13.09.2026)

Grundlage ist die R6A-SSOT, nicht die Erinnerung. Baseline `5fc7bb2`, Version 0.8.54, Registry **108**, ursprüngliche
40er-Matrix **36 / 0 / 0 / 4** + `invoices.cancel`, Kategorie B offen **0**. R6C fasst die in R6A getrennt geplanten
Scheiben R6C (Stammdaten) und R6D (Inventur) zu einem Bündel zusammen.

### Umfang, eingefroren (`CENTRAL_UI_R6C_SCOPE_FROZEN`)

Aus der SSOT gelesen: alle A-Zeilen mit der Domäne **Stammdaten** oder **Inventur** — 16 Einstiege, davon drei
Schnellanlagen. Primary-Laufweg, Befund und PC2-Stand VOR R6C:

| UI-Einstieg | Laufweg am Primary | Primary fachlich korrekt? | PC2 vorher | gemeinsame Domäne | Fernbuchung |
|---|---|---|---|---|---|
| „New Supplier" (SupplierList) | `createSupplier(form)` | **nein**: Name aus Leerzeichen ging durch, nicht getrimmt | TOT | `masterdata-rules` + Store | `suppliers.create` |
| „+ New Supplier" (PurchaseCreate) | `createSupplier(newSupplierForm)`, danach gewählt | **nein**: wie oben | TOT (ungefangen) | dieselbe | `suppliers.create` |
| „+ New Supplier" (RepairList) | `createSupplier({name, phone})`, danach gewählt | ja (trimmte als einzige) | TOT | dieselbe | `suppliers.create` |
| Lieferant ändern (SupplierDetail) | `updateSupplier(id, alle Felder)` | **nein**: geleerter Name schrieb „"; alle Felder zurückgeschrieben | TOT | dieselbe | `suppliers.update` |
| Lieferant (de)aktivieren | `updateSupplier(id, {active: !active})` | ja (Umschalter) | TOT | dieselbe | `suppliers.update` (Zielwert) |
| Agent ändern (AgentList „Edit Approval") | `updateAgent(id, {...agent})` | **nein**: schrieb `total_sales`/`total_commission` aus dem Stand beim Öffnen zurück | TOT | dieselbe | `agents.update` |
| Partner anlegen | `createPartner(form)` | **nein**: Name aus Leerzeichen, Anteil ohne Grenze (250 %, −10 %) | TOT | dieselbe | `partners.create` |
| Partner speichern | `updatePartner(id, {...partner})` | **nein**: wie oben | TOT | dieselbe | `partners.update` |
| Mitarbeiter anlegen | `createEmployee(...)` | **nein**: negatives Grundgehalt ging durch | TOT (Alert) | dieselbe | `employees.create` |
| Beurlauben/Reaktivieren (Liste) | `setStatus(id, s)` | ja | TOT | dieselbe | `employees.update` (Zielstatus) |
| Beurlauben/Reaktivieren (Detail) | `setStatus(id, s)` | ja | TOT | dieselbe | `employees.update` (Zielstatus) |
| Mitarbeiter speichern | `updateEmployee(id, {...employee})` | **nein**: wie Anlegen; alle Felder zurückgeschrieben | TOT | dieselbe | `employees.update` |
| Inventur öffnen (Lauf beginnen) | Maske: `ensureOpenSession` + Einfalten, direkt in die DB | **nein**: an der Schreibreihenfolge vorbei, ohne Transaktion | gesperrt (R6B) | `inventory-house` | `inventory.start` |
| Inventur speichern | Maske: `recordStockCheck` je Artikel + `persistSessionItems` | **nein**: wie oben; ein eben angelegter Artikel fiel im Kern durch (Datei noch nicht gespeichert) | gesperrt (R6B) | `inventory-house` | `inventory.save` |
| Inventur abschließen | Maske: `closeSession` | **nein**: an der Schreibreihenfolge vorbei | gesperrt (R6B) | `inventory-house` | `inventory.finish` |
| Einzel-Check (ProductDetail) | `recordStockCheck` | wie Speichern | gesperrt (R6B) | `inventory-house` | `inventory.record_check` |

**Nicht im Umfang, mit Grund (Domänenspalte der SSOT):** Aufgaben ×2 und Dokumente/OCR ×2 sind *Büro* (→ R6G),
Metall anlegen/verkaufen/schmelzen ×3 sind *Metall/Geld* (→ R6F, mit der Gold-Familie), „Inbox-Foto verwerfen" ist
*Einkauf* (→ R6G). Einen weiteren Schnellanlage-Einstieg gibt es nicht: „+ New Client" ist seit R5D.1 angeschlossen,
die Kommission legt ihren Lieferanten innerhalb von `consignments.create` an.

### Primary zuerst (`CENTRAL_UI_R6C_PRIMARY_FIRST_CONTRACT_PROVED`)

Jede Befund-Zeile oben ist in der **gemeinsamen Domäne** behoben, nicht nur im Fernweg:

- **Eine Regel** (`core/masterdata/masterdata-rules.ts`): Name Pflicht und getrimmt, Texte getrimmt, ein geleertes Feld
  beim Ändern ist `null`, Partneranteil 0–100 %, Grundgehalt ≥ 0, Status aus der festen Liste. Die Hausfunktionen
  (`createSupplier`, `updateSupplier`, `updateAgent`, `createPartner`, `updatePartner`, `createEmployee`,
  `updateEmployee`) prüfen selbst mit ihr — für jeden Einstieg, am Primary wie fern, mit demselben Code.
- **Agent**: `total_sales`/`total_commission` sind in `updateAgent` nicht mehr schreibbar (die führt
  `automation-handlers` beim Verkauf) — ein Verkauf während offener Maske bleibt stehen.
- **Ändern schickt nur das Geänderte** (Lieferant, Agent, Partner, Mitarbeiter; M-01). Die Login-Verknüpfung eines
  Mitarbeiters bleibt Hauskonfiguration.
- **Schreibreihenfolge**: jede Stammdaten-Handlung am Primary läuft über `runOnPrimary` (exklusiv, eine Transaktion,
  danach durabel), die Inventur über `runExclusive` mit eigener Transaktion. Vorher schrieben alle Masken synchron an
  der Warteschlange vorbei; ein Fernauftrag, der gerade auf Bytes wartete, hätte ihre Zeilen in seine Transaktion
  genommen.
- **Inventur**: die Maske fasst keine Datenbank mehr an; vor dem Speichern wird die offene Speicherschuld beglichen (der
  Kern prüft Artikel gegen die Datei auf der Platte). Der R6B-Fix (kein Schließen nach halbem Erfolg) bleibt.

### Lieferant anlegen — der Vertrag (`CENTRAL_UI_R6C_SUPPLIER_CREATE_PROVED`)

Pflicht: **Name**. Optional: Telefon (mit Ländervorwahl, nur weiche Warnung), E-Mail, Adresse, Notizen, CPR (weiche
Warnung), Ausweisfoto. Keine USt-/CR-Felder, **kein Eröffnungssaldo**. Filiale und Benutzer aus der Sitzung des Primary,
immer aktiv, Kennung UUID. **Doppelgänger**: das Haus warnt (Hinweisband, `findSimilarContacts`), es sperrt nicht —
dieselbe Regel wie beim Kunden; ein neuer Vorsatz ist ein neuer Lieferant, eine verlorene Antwort nicht (durabler
Nachweis). Protokoll: `trackInsert`. **Eine** Buchung für alle drei Einstiege (`suppliers.create`); das Ausweisfoto
reist über die vorhandene Ablage aus R5B (`cprImageStagingId`), nie als Bytes im Auftrag.

### Stammdaten — geschlossen (`CENTRAL_UI_R6C_MASTERDATA_GAPS_CLOSED`)

Eine fachliche Aktion, ein Name — sieben Buchungen für zwölf Einstiege (`core/bridge/masterdata-commands.ts`):
`suppliers.create` (3), `suppliers.update` (2), `agents.update` (1), `partners.create` (1), `partners.update` (1),
`employees.create` (1), `employees.update` (3). Kein vorhandener Befehl war funktional gleich (Lieferant, Agent,
Partner, Mitarbeiter hatten keinen Fernweg). Jeder Befehl: typisierter Rumpf mit Verbots- und Zulassungsliste,
Filialprüfung (`BRANCH_MISMATCH`), Existenz in der Filiale (`*_NOT_FOUND`), die Regel als Rumpf- und als
Domänenurteil, durabler Nachweis. Kein Löschen (§5), kein Geld (R6E).

### Schnellanlagen — derselbe Ablauf (`CENTRAL_UI_R6C_QUICK_CREATE_RUNTIME_PROVED`)

`+ New Supplier → Maske → Save → sofort da → gewählt` auf beiden Rechnern: `saveSupplierCreate` prüft vor dem Schicken
mit derselben Regel, legt am Primary über die Hausfunktion an, auf PC2 über `suppliers.create`, und holt danach den
Bestand frisch vom Primary, **bevor** die Maske weitermacht — Einkauf und Werkstatt wählen den neuen Lieferanten sofort
(bestehender Vertrag), ohne Neuladen. Kein lokaler Store-Write auf PC2, keine Dublette bei verlorener Antwort.

### Inventur — was sie in diesem Haus ist (`CENTRAL_UI_R6C_INVENTORY_PRIMARY_SEMANTICS_AUDITED`)

- **Lebenszyklus**: ein offener Lauf je Filiale; das Öffnen der Maske beginnt ihn (bei der frühesten nicht erfassten
  Beobachtung) oder nimmt den offenen auf; nur „Finish" beendet ihn; nichts läuft ab.
- **Gezählt wird geurteilt**: verfügbar / nicht verfügbar, mit Notiz — kein Sollbestand, keine Stückzahl, **keine
  Differenz, keine Bestandsbuchung, kein Hauptbuch**. Ein Urteil ist eine Beobachtung (`stock_checks` im Kern des
  Primary, anhängend, Anfragekennung macht Wiederholungen harmlos) und steht im Arbeitsblatt
  (`inventory_session_items`). Abschließen legt das Arbeitsblatt weg; der Verlauf bleibt.
- **Erfasst** werden die Artikel der gefilterten Sammlung; Telefon-Beobachtungen während des Laufs werden genau einmal
  eingefaltet. Wiederaufnahme: nach Tagen, nach Neustart, von jedem Rechner. Kein Recht nötig (Befund: kein Tor am Primary).

### Inventur — das Befehlsmodell (`CENTRAL_UI_R6C_INVENTORY_COMMAND_MODEL_PROVED`)

Aus dem Lebenszyklus abgeleitet — vier getrennte Absichten, zwei Auskünfte (`core/stock/inventory-house.ts`,
`core/bridge/inventory-commands.ts`): `inventory.start`, `inventory.save`, `inventory.finish`,
`inventory.record_check`; `inventory.session.get` (Arbeitsblatt + letzte Beobachtung je Artikel),
`inventory.checks.get` (Verlauf eines Artikels). Speichern und Abschließen bleiben zwei Absichten: Abschließen speichert
nichts, Speichern schließt nichts. Die Ergebnisse sind klein (eingefroren wird keine Liste); das Arbeitsblatt liest die
Maske danach über die Auskunft. PC2 fragt nie seinen eigenen Kern (R6B-Invariante bleibt).

### Nebenläufigkeit (`CENTRAL_UI_R6C_INVENTORY_CONCURRENCY_PROVED`)

Neue Spalte `inventory_sessions.revision` (additiv). Speichern und Abschließen nennen die **gesehene Fassung**; jede
Wirkung zählt sie hoch. Eine veraltete Fassung ist ein klares, eingefrorenes Nein (`INVENTORY_SESSION_STALE`) — vor jeder
Beobachtung. Am Primary wird die Fassung zusätzlich **innerhalb** der Transaktion vor dem Arbeitsblatt noch einmal
geprüft (zwischen den Beobachtungen kann ein Fernauftrag gelaufen sein). Vertrag bei mehreren Geräten nacheinander:
sehen, dann schreiben — wer abgewiesen wird, öffnet neu. Kein Multi-Writer-Neudesign; alles läuft durch die eine
Schreibreihenfolge des Primary und seine Transaktionsgrenze; Hintergrund-Speichern beendet keine offene Transaktion
(R5B-Regeln unverändert).

### Atomarität (`CENTRAL_UI_R6C_INVENTORY_ATOMICITY_PROVED`)

Reihenfolge beim Speichern: prüfen → Beobachtungen (je wiedererkennbare Anfragekennung `<commandId>:<productId>`) →
**erst wenn alle stehen** Arbeitsblatt + Fassung in einer Transaktion. Fehlerinjektion an echten Punkten:
nach dem Anlegen des Laufs (kein Lauf, keine Zeile), nach der ersten Beobachtung (Arbeitsblatt und Fassung unverändert;
dieselbe Kennung findet sie wieder — keine doppelte), beim Abschließen (Lauf bleibt offen, Arbeitsblatt vollständig),
während der Durabilität (kein Erfolg; dieselbe Kennung: eingefrorene Antwort, keine zweite Beobachtung). Differenzrechnung
und Bestandsbuchung gibt es nicht — bewiesen: die Hausfolge hat keinen Weg zu `products`, `stock_lots` oder dem
Hauptbuch; Bestand und Hauptbuch sind nach dem ganzen Lebenszyklus unverändert.

### Sicherheit (`CENTRAL_UI_R6C_INVENTORY_INPUT_AUTHORITY_PROVED`)

Serverseitig abgewiesen: fremde Filiale (Ausweis und Artikel), fremde/erfundene Sitzung, Artikel außerhalb der Inventur,
drittes Urteil, zwei Urteile je Artikel, Notiz über 500 Zeichen, fehlende oder alte Fassung, und jeder vom Client
genannte Soll-/Ist-Bestand, jede Differenz, jeder Zeitstempel, Benutzer, jede Beobachtungskennung (Rumpf und Zeile).
Der Primary bestimmt Beginn, Fassung, Zuordnung, Zeit und Kennung.

### Zwei echte Anwendungen (`CENTRAL_UI_R6C_INVENTORY_RUNTIME_PROVED`)

`test/e2e/r6c-masterdata-inventory.e2e.mjs`, frisch gebaute Programme, Primary + datenloser ADMIN-PC2 mit einer ALTEN
`lataif.db` im Datenordner: drei „+ New Supplier" (je genau EIN `suppliers.create`, sofort gewählt), Lieferant ändern
(nur das Geänderte) und deaktivieren (Zielwert), Agent (Summen unberührt), Partner, Mitarbeiter (anlegen, Status in
Liste und Detail, ändern) — jeweils Primary == PC2. Inventur: beginnen → zählen → speichern mit **verlorener Antwort**
(zweimal dieselbe Kennung, genau zwei Beobachtungen, Fassung genau einmal hoch) → wieder öffnen (vom Primary gelesen)
→ Primary ändert → PC2 mit alter Fassung **abgewiesen**, nichts geschrieben → abschließen; sauberer Zwilling Primary ==
PC2; Einzel-Check. Kein Datenbankgriff, kein Kernaufruf, die alte Datei unberührt, keine neue Datei.

### E2E-Prozess-Isolation — dauerhafte Test-Invariante

Kein Harness beendet mehr pauschal `lataif.exe`. `test/e2e/_e2e-process.mjs` ist die einzige Stelle mit `taskkill` —
nur mit `/PID`, nur für Prozesse am **exakten** Test-Pfad (`target/debug/lataif.exe`, `lataif-e2e-client.exe`) oder
selbst gestartete (gespeicherte PID, Pfad nachgeprüft); Headless-Browser nur mit eigener Profilkennung. Alle
E2E-Dateien sind umgestellt. Gate `test/e2e-safety/process-isolation.test.ts` (im Node-Sweep): kein anderer
Beende-Aufruf, kein Image-Name, kein `E:\LATAIF`, kein Port 3001/3443, Produktions-AppData nur lesend — und ein echter
Harness-Beweis: ein Köder gleichen Namens an einem anderen Pfad überlebt jede Aufräumroutine, fremde `lataif.exe`
(die Produktion) laufen danach weiter.

### Test-Delta (alte Pins, bewusst geändert)

- Registry-Pins **108 → 121** und Buchungs-Pins **41 → 52** in 26 Gates; die Namenslisten tragen die elf neuen Buchungen
  und die zwei Auskünfte am Ende. `invoices.cancel` bleibt die eine R5F.1-Buchung an Platz 41; der R5F.1-Vergleich
  „vorher/jetzt" nennt die R6C-Namen ausdrücklich.
- `r4c-write-matrix`: die Vierziger-Matrix bleibt abgeschlossen; die R6C-Buchungen stehen daneben (wie
  `invoices.cancel`). `r3-write-matrix`: „Inventursitzung ist eine Lücke" → „seit R6C geschlossen".
- `r5e/order-contract-pins` §5: die festgehaltene Lücke „+ New Supplier" ist geschlossen (Buchung vorhanden, dieselbe
  Folge an allen Einstiegen).
- `r2c-direct-db-scan`: die Inventurmaske hat keinen direkten Datenbankzugriff mehr (Eintrag entfernt).
- `r6b/safety-existing-commands` §3: die R6B-Sperre der Inventur ist durch den Weg über den Primary ersetzt; weiter
  geprüft: kein Aufruf des eigenen Kerns auf dem Client, kein halber Erfolg, kein „finished" ohne Wirkung.
- Rust `bridge_tests`: 121 Namen, die 52 Buchungen namentlich.

### Beweise

```
Unit  r6c/masterdata-parity 88/0 · r6c/inventory-parity 81/0 · e2e-safety/process-isolation 31/0
E2E   r6c-masterdata-inventory 120/0 (zwei echte Anwendungen, frisch gebaut; Isolation: nur eigene Prozesse beendet)
Nachbarn (26 Registry-/Matrix-Gates, r6b, r5*, r4*, r3, r2c, stock/*, c4/c6) grün · Rust bridge 37/0
TS    tsconfig.app 0 · tsconfig.node 0 · Lint-Delta 0
Registry 121 · Matrix 36/0/0/4 + invoices.cancel (unverändert)
```

### Stand der R6A-SSOT nach R6C

```
A vorher            95
A in R6C behandelt  16   (12 Stammdaten, davon 3 Schnellanlagen · 4 Inventur)
A geschlossen       16
A verbleibend       79
neue Fernbuchungen  11   (suppliers.create/update, agents.update, partners.create/update,
                          employees.create/update, inventory.start/save/finish/record_check)
neue Auskünfte       2   (inventory.session.get, inventory.checks.get)
Registry            108 → 121   (1 Probe + 68 Auskünfte + 52 Buchungen)
B 0 offen · C 15 · D 12 · E 41 (unverändert)
```

Nächste Scheiben: R6E Finanzen/Steuer · R6F Gold (mit Metall) · R6G Lebenszyklen (mit Aufgaben, Dokumenten, Inbox-Foto).

### R6C Final Gate — Registry-Diff und festgeschriebene Verträge

Gegen den Stand VOR R6C (`5fc7bb2`, aus Git gelesen) sind **genau** diese dreizehn Namen dazugekommen — keine anderen,
keiner fiel weg; TS-Registrierung == Rust-Zulassung == 121 (`CENTRAL_UI_R6C_REGISTRY_121_AUDITED`):

| Name | Oberfläche / Domäne | TS | Rust | Recht | Idempotenz / Fassung |
|---|---|---|---|---|---|
| `suppliers.create` | SupplierList, PurchaseCreate, RepairList · Stammdaten | `masterdata-commands` | `OP_SUPPLIERS_CREATE` | kein Tor (wie Primary) | Kennung + durabler Nachweis |
| `suppliers.update` | SupplierDetail Save + (De)aktivieren · Stammdaten | `masterdata-commands` | `OP_SUPPLIERS_UPDATE` | kein Tor | Kennung; Feld-Diff, Aktiv als Zielwert |
| `agents.update` | AgentList „Edit Approval" · Stammdaten | `masterdata-commands` | `OP_AGENTS_UPDATE` | kein Tor | Kennung; Feld-Diff, keine Summen |
| `partners.create` | PartnersPage „New Partner" · Stammdaten | `masterdata-commands` | `OP_PARTNERS_CREATE` | kein Tor | Kennung |
| `partners.update` | PartnersPage „Edit Partner" · Stammdaten | `masterdata-commands` | `OP_PARTNERS_UPDATE` | kein Tor | Kennung; Feld-Diff |
| `employees.create` | EmployeeList „New Employee" · Stammdaten | `masterdata-commands` | `OP_EMPLOYEES_CREATE` | kein Tor | Kennung |
| `employees.update` | EmployeeList/-Detail Status + Save · Stammdaten | `masterdata-commands` | `OP_EMPLOYEES_UPDATE` | kein Tor | Kennung; Feld-Diff, Status als Zielwert |
| `inventory.start` | WatchList „Stock Check" · Inventur | `inventory-commands` | `OP_INVENTORY_START` | kein Tor | Kennung; von Natur aus wiederholbar (derselbe offene Lauf) |
| `inventory.save` | Inventurmaske „Save" · Inventur | `inventory-commands` | `OP_INVENTORY_SAVE` | kein Tor | Kennung; **gesehene Fassung Pflicht**; Beobachtung `<commandId>:<productId>` |
| `inventory.finish` | Inventurmaske „Finish" · Inventur | `inventory-commands` | `OP_INVENTORY_FINISH` | kein Tor | Kennung; **gesehene Fassung Pflicht** |
| `inventory.record_check` | ProductDetail Einzel-Check · Inventur | `inventory-commands` | `OP_INVENTORY_RECORD_CHECK` | kein Tor | Kennung = Anfragekennung der Beobachtung |
| `inventory.session.get` | Inventurmaske (lesen) | `store-read-commands` | `OP_INVENTORY_SESSION_GET` | kein Tor (Lesen) | — (nur Artikel der Filiale) |
| `inventory.checks.get` | Einzel-Check-Verlauf (lesen) | `store-read-commands` | `OP_INVENTORY_CHECKS_GET` | kein Tor (Lesen) | — (nur Artikel der Filiale) |

Unbekannte Namen bleiben fail-closed (`BRIDGE_OP_NOT_REGISTERED`; `suppliers.delete`, `inventory.adjust`,
`metals.create`, `tasks.create` … weder registrierbar noch in Rust).

**Stammdaten — Autorität des Primary** (`CENTRAL_UI_R6C_MASTERDATA_AUTHORITY_PINNED`): keine Summe, kein Saldo, keine
Provision aus einem Formularstand (weder in den Feldlisten noch in der Hausfunktion); Filiale und Kennung (UUID v4) nur
vom Primary, Datensätze fremder Filialen „nicht vorhanden"; leere Pflichtnamen am Primary und fern mit demselben Code
abgewiesen; Partneranteil **0–100 %** (Bereich des Modells); Grundgehalt **≥ 0** (endliche Zahl; negativ abgewiesen,
keine Obergrenze — Primary und PC2 dieselbe Regel); Aktiv-Schalter nur als echter Wahrheitswert, Mitarbeiterstatus nur
`active`/`on_leave`/`inactive`, jeder Übergang zwischen ihnen erlaubt wie am Primary.

**Inventur — Vertrag** (`CENTRAL_UI_R6C_INVENTORY_CONTRACT_PINNED`): erfasst werden verfügbar / nicht verfügbar, Notiz
(≤ 500), Beobachtung und Lauf-/Arbeitsblattzustand. Schreibziele vor und nach R6C identisch: `inventory_sessions`,
`inventory_session_items` (plus der einmalige Bootstrap-Stempel), im Kern nur `stock_checks` (Geschäftsdatei nur
lesend). **Kein** Mengenausgleich, **keine** Differenz-, Hauptbuch- oder Ausgabenbuchung; Soll-/Ergebnisbestand und
Differenz existieren nur als abgewiesene Namen. Fassung: start 1 · Einfalten +1 · Speichern +1 · Speichern ohne
Änderung ±0 · Einzel-Check ±0 · Abschließen +1 · neuer Lauf 1. Umfang: eine Inventur umfasst **alle** Artikel der
Filiale, ohne Höchstzahl. Der Kern beantwortet je Aufruf nur 1 000 Artikel; der Anschluss fragt deshalb in Blöcken zu je
1 000 — der alte Primary-Fehler (nur die ersten 1 000 wurden eingefaltet) ist behoben
(`CENTRAL_UI_R6C_NO_INVENTED_LIMITS_PINNED`, `CENTRAL_UI_R6C_INVENTORY_BEYOND_1000_PROVED`).

**Inventur — Durabilität** (`CENTRAL_UI_R6C_INVENTORY_DURABILITY_PINNED`): alte Fassung vor jedem Schreiben abgewiesen
(kein Kernaufruf); gescheitertes Speichern schließt die Maske nicht, gescheitertes Abschließen meldet kein „finished";
ohne bestätigtes Speichern kein Erfolg, dieselbe Kennung danach genau eine Wirkung; am Primary Schreibreihenfolge + eigene
Transaktion + erst danach durabel, die Hausfolge committet und speichert nie selbst; auf PC2 wird weder der eigene Kern
noch die lokale Hausfolge berührt — eine alte `lataif.db` dort ist bedeutungslos.

**E2E-Prozess-Isolation, verschärft** (`CENTRAL_UI_R6C_E2E_PROCESS_ISOLATION_PINNED`): ein Kindprozess des laufenden
Tests wird nur beendet, wenn PID **und** absoluter Startpfad noch zusammenpassen (`killOwnChild`); Reste früherer Läufe nur
am exakten Test-Pfad; nie nach Name, Befehlszeile oder bloßer PID (das Aufräumen fremder Headless-Browser nach
Befehlszeile ist entfernt); ein `lataif.exe`-Köder an einem anderen Pfad überlebt; Produktions-Datenort und Ports bleiben
im Gate verboten.

```
Final Gate  r6c/final-gate 134/0 · e2e-safety/process-isolation 35/0 · r6c/masterdata 88/0 · r6c/inventory 81/0
            r6c/inventory-large 28/0 (1 205 Artikel; Kern kürzt je Aufruf auf 1 000 wie lib.rs)
            c4-authorization · c4-read-revocation · r6b grün · Rust bridge grün · TS 0/0 · Lint-Delta 0
R6A         A 95 · R6C 16 · geschlossen 16 · verbleibend 79 (Aufgaben, Dokumente, Metall, Inbox-Foto offen)
Korrektur   Gehalt ohne Obergrenze · Inventur ohne Höchstzahl, Lesen in 1 000er-Blöcken — nur gemeinsame
            Domäne/Validierung, Registry 121 unverändert → Zwei-App 120/0 (e03478c) bleibt gültig
```

## R6D — Finanzen, Steuer, Buchhaltung, Gold und Metall (13.09.2026)

Ein Bündel, vier Domänen: Steuer/Bank/Gesellschafter/Darlehen, Verbindlichkeiten (Ausgaben, Vorlagen, Einkaufszahlung,
Lieferant), Gold (Abrechnung, Verbrauch, Material, Kostenzeilen) und Edelmetall/Schrotthandel. Grundregel für jede
Aktion: **Primary fachlich prüfen → Primary-Fehler in der gemeinsamen Domäne beheben → Fernbuchung auf dieselbe Domäne
→ Primary und PC2 gemeinsam testen.** Kein Primary-Fehler wurde in den Fernweg kopiert.

### Umfang, eingefroren (`CENTRAL_UI_R6D_SCOPE_FROZEN`)

Aus der SSOT gelesen (nicht aus Erinnerung): alle offenen A-Zeilen der Domänen Geld, Steuer, Ausgaben, Buchung,
Gold, Metall und Filialeinstellung (Spotpreis) sowie die Kosten-/Materialzeilen mit Gold-Schuld — **41 Einstiege**.

| Domäne | UI-Einstiege (SSOT) | Laufweg am Primary vorher | Primary korrekt? | PC2 vorher | gemeinsame Domäne | Fernbuchung |
|---|---|---|---|---|---|---|
| Steuer | Steuerzahlung eintragen (AnalyticsPage) | roher INSERT `tax_payments` aus der Seite | **nein**: keine Buchung, Fehler nur Konsole + Maske schloss, leeres Datum, Ersatzfiliale | versteckt | `core/finance/money-house` | `tax.record_payment` |
| Bank | Umbuchung Kasse ↔ Bank | `createTransfer` + `safePost` | **nein**: Halbzustand möglich, keine Prüfung | TOT | money-house | `banking.transfer` |
| Gesellschafter | Einlage / Entnahme / Gewinnverteilung | `recordTx` + `safePost` | **nein**: Halbzustand, keine Existenzprüfung | TOT | money-house | `partners.record_tx` |
| Darlehen | anlegen · Rückzahlung · speichern | `createDebt` / `recordDebtPayment` / `updateDebt` | **nein**: Überzahlung, Zahlung auf storniert, Ledger-Drift beim Berichtigen, Cache-Richtung | TOT | money-house | `debts.create/record_payment/update` |
| Ausgaben | anlegen · speichern · zahlen (+ 3 Öffner: Lieferant, Auftrag, Reparatur) | `createExpense` / `updateExpense` / `recordExpensePayment` | **nein**: drei Commits, Überzahlung still gekappt, Betrag/Datum ohne Ledger-Korrektur, Snapshot-Rückschreiben | TOT | `core/payables/payables-house` | `expenses.create/update/record_payment` |
| Vorlagen | anlegen · pausieren/fortsetzen · speichern | `createTemplate` / `updateTemplate` + Generator | **nein**: Resume holt Pausenmonate samt Zahlungen nach, Betrag 0, veraltetes Rückschreiben | TOT | payables-house | `expenses.template_create/update` |
| Einkauf | Zahlung erfassen · Guthaben verrechnen | `addPayment` / FIFO-Schleife in der Seite | **nein**: überschrieb guthabenbewussten Rest, Schleife ohne Klammer, stilles Weniger | TOT | payables-house | `purchases.record_payment/apply_credit` |
| Lieferant | bezahlen (+ Öffner) · Guthaben anwenden · Guthaben erstatten | Zahlschleife / Alt-Server / `deleteStandaloneSupplierCredit` | **nein**: Rest ohne Guthaben, nicht atomar; Guthaben-Weg kam am Primary nie an; Erstatten korrekt | TOT / VERST | payables-house | `suppliers.pay/apply_credit/refund_credit` |
| Gold | Kundengold zurück/→ BHD ×4 · Werkstatt-Gold zurück/Shop-Gold/→ BHD ×7 · Goldverbrauch | goldStore, Modal liest Cache | **nein**: „wird zurückgewiesen" nie geprüft, Bestand nie geprüft, Karat ?? 1,0, Cross-Karat nie genau, verschluckte Umwandlung | TOT | `core/gold/gold-settle` + `gold-house` | `gold.payables.settle`, `gold.customer_credits.settle`, `repairs.record_gold_usage` |
| Kosten/Material | Kostenposition hinzufügen/löschen (Auftrag) · Material (Reparatur) | `addOrderLine`/`addRepairLine` + `createGoldPayable` je Zeile | **nein**: je Zeile ein Commit (Duplikate bei Wiederholung), teilbeglichene Schuld hart gelöscht | TOT | gold-house | `orders.add_cost/remove_cost`, `repairs.add_material` |
| Metall | anlegen · verkaufen · schmelzen · Spotpreis | `createMetal` (bis 4 Commits) / `updateMetal` / `setSpotPrice` je Taste | **nein**: Halbzustände, kein Statuswächter, negatives Gewicht, Spot aus der Maske | TOT | `core/metals/metal-house` | `metals.create/update_status/set_spot_price` |
| Schrotthandel | anlegen · ändern · stornieren | Store: INSERTs + eigener Post, Storno setzt Status VOR Umkehr | **nein**: Duplikat nach Fehler, keine Fassungsprüfung, Storno ohne Wiederholungsweg | TOT | `core/metals/scrap-house` | `scrap_trades.create/update/cancel` |

Nicht im Umfang (andere Domänen der SSOT): Angebote, Rechnung anlegen+zahlen/Sondernummer/Butterfly/Retoure stornieren,
Einkauf zurückgeben/stornieren, Auftrag stornieren + Zeilenstatus, Kommission, Transfer rückgängig, Produktion, Aufgaben,
Dokumente/OCR, Nachrichtenprotokoll, Bildänderung am Artikel, Inbox-Foto.

### Primary zuerst — Befunde und Behebung (`CENTRAL_UI_R6D_PRIMARY_FIRST_PROVED`)

Jede Befund-Zeile ist in der gemeinsamen Domäne behoben; der Primary läuft seither über `runOnPrimary` (Schreibreihenfolge,
eine Ledger-Transaktion, erst danach durabel), PC2 über `runRemoteCommand` — **dieselbe** Hausfolge.

- **Steuer** (`CENTRAL_UI_R6D_TAX_PAYMENT_CONTRACT_PROVED`): „Tax Payment" = Abführung der Umsatzsteuer eines
  Geschäftsquartals. Ausgeglichen wird das Quartal `year`/`quarter` (die Maske nennt es, der Primary prüft es gegen
  dieselbe Quartalsrechnung wie die Anzeige: `financeFor(ctx).quarterly`, `vatQuarterState()`) — ein beglichenes oder
  ein Erstattungsquartal wird abgewiesen (`TAX_QUARTER_SETTLED`, `TAX_QUARTER_REFUND_DUE`). Teilzahlung erlaubt;
  Überzahlung ungedeckelt wie im bisherigen Vertrag (keine erfundene Grenze). Zahlweg bar oder Bank. Buchung
  `postTaxPayment`: Soll TAX_PAID / Haben CASH oder BANK, Quelle `TAX_PAYMENT` — dieselbe, die die Nachbuchung schon
  kannte. Was offen ist, rechnet die Quartalsrechnung wie bisher aus `tax_payments` (nach `year`/`quarter`).
  Zeile und Buchung in EINER Transaktion; Fehler bleiben in der Maske stehen.
- **Bank/Gesellschafter/Darlehen**: atomar und streng (kein `safePost` mehr in der Handlung); Partner, Kunde,
  Mitarbeiter müssen in der Filiale existieren; Gegenpartei und Belegnummer vom Primary; Rückzahlung höchstens der
  Rest (abgeleitet aus der Invariante „Betrag nie unter Bezahltem" von `updateDebt`), nicht auf storniert/getilgt;
  Berichtigen von Betrag/Konto spiegelt die LOAN-Buchung und bucht neu; storniert → `DEBT_CANCELLED`.
- **Verbindlichkeiten**: Ausgabe samt Erstzahlung und beiden Buchungen in einer Transaktion; Gehalt braucht den
  Mitarbeiter vor der Nummernvergabe; Überzahlung abgewiesen statt gekappt; Speichern nur der Formularfelder, nie unter
  das Bezahlte (bar + Guthaben), Betrag/Datum → Storno und Neubuchung; Resume ohne Pausenmonate (Zusage der Maske);
  Einkaufszahlung guthabenbewusst, Überzahlung → Lieferantenguthaben in derselben Transaktion; Guthaben-FIFO nur über die
  Filiale, alles oder nichts; Lieferant bezahlen guthabenbewusst und atomar; Guthaben anwenden über den atomaren lokalen
  Schreiber (der Alt-Server-Weg kam am Primary nie an).
- **Gold** (`CENTRAL_UI_R6D_GOLD_METAL_DOMAIN_PROVED`): „Settle — Workshop returns gold" bleibt Zugang ins Ladengold
  (dokumentierte Absicht der Maske), „Apply shop gold" Abgang; beide senken die offene Schuld. Was die Maske als
  „wird zurückgewiesen" ankündigte, wird jetzt zurückgewiesen (`GOLD_OVER_SETTLEMENT`, `GOLD_SHOP_STOCK_INSUFFICIENT`).
  Karat nur aus `KARAT_PURITY` (kein stilles 1,0); Cross-Karat mit einer Toleranz von einem halben Eingabeschritt
  (0,0005 · P[Quelle]/P[Ziel]) — genau getroffen heißt erfüllt. Umwandlung in BHD atomar (Guthabenzeile + Buchung
  `postGoldConversionCredit` bzw. Ausgabe + `postExpense`). Liest aus der DB in der Transaktion, nicht aus dem Cache.
  Teilbeglichene Schuld ist nicht mehr löschbar (`GOLD_PAYABLE_PARTLY_SETTLED`). Bestand nur `metal_type='gold'`.
  Dieselbe Gold-Schuld-Semantik wie R5E (`createGoldPayable`, we_owe / return_gold) — keine zweite Gramm-/Karatlogik.
- **Metall/Schrott**: Anlage in einer Transaktion (Zeile, Goldbewegung, Lieferantenausgabe, Buchung, Verknüpfung);
  Spot und Schmelzwert vom Primary; Verkauf/Schmelzen nur aus `in_stock`; Spotpreis beim Verlassen des Feldes statt je
  Taste; Schrott anlegen/ändern/stornieren atomar, Fassung gegen die Zeile, Storno erst Umkehr dann Status.

Bewusst **nicht** geändert (Befunde, eigene Entscheidung nötig): Quartalsschlüssel bei Geschäftsjahr ≠ 1/4/7/10,
gemeinsamer PWD-Nummernkreis für Entnahme und Gewinnauszahlung, Goldbewegung bei Verkauf/Schmelzen, zwei Spotpreis-Quellen,
Schrott ohne Gegenpartei im Hauptbuch. Die vier Buchhaltungsfragen sind im Accounting-Gate unten entschieden.

### Accounting-Gate — die vier Buchhaltungsverträge, entschieden aus dem Modell (13.09.2026)

**Steuerzahlung** (`CENTRAL_UI_R6D_TAX_ACCOUNTING_CONTRACT_PINNED`). Das Hauptbuch führt die Umsatzsteuer bei der Rechnung
als Verbindlichkeit (Haben VAT_OUTPUT / MARGIN_VAT, Umsatz netto) und die Vorsteuer beim Einkauf als Forderung (Soll
VAT_INPUT). Die Abführung buchte Soll TAX_PAID / Haben Kasse oder Bank — und TAX_PAID war in `ledger/queries.ts` als
**Aufwand** eingeordnet; keine Stelle verrechnete es mit der Verbindlichkeit, die Steuerschuld des Hauptbuchs blieb
fachlich offen und wuchs mit jedem Quartal (die „noch zu zahlende" Steuer rechnete nur die Quartalsauswertung aus den
Belegen). Kein Gewinnausweis zählte TAX_PAID. **Entschieden und korrigiert**: TAX_PAID ist das **Verrechnungskonto der
Umsatzsteuer** (abgeführte Steuer), keine Aufwandsbuchung; die offene Steuerschuld des Hauptbuchs ist genau eine Definition,
`vatPosition()` = VAT_OUTPUT + MARGIN_VAT − VAT_INPUT − TAX_PAID. Die Buchung selbst bleibt, wie die Nachbuchung sie
schon kannte — Altbestände bleiben gültig. `cashflow()` zog die Abführung doppelt ab (Kasse/Bank UND TAX_PAID) —
behoben. Gepinnt: Schuld 100 → Abführung 60 (Bank −60, TAX_PAID +60) → offen 40 → Rest 40 → offen 0 = die Quartalsauswertung
„beglichen". **Überzahlung**: die Quartalsauswertung ordnet eine Zahlung ihrem Quartal zu und trägt einen Überschuss
nicht vor — kein Vertrag verarbeitet ihn später. Deshalb höchstens der offene Rest (`TAX_OVERPAYMENT`).

**tax_payments und der Sync** (`CENTRAL_UI_R6D_TAX_PAYMENT_SYNC_CONTRACT_PINNED`): **NOT REQUIRED.** Alle Leser und
Schreiber sitzen am Primary (Hausfolge, Quartalsauswertung, Kontext, Abgleich, Nachbuchung, Schema); PC2 ohne Datenbank
sieht die Zahlungen nur über die Auskunft `store.analytics.get` des Primary; die Tabelle steht nicht im Sync-Manifest und
der Sync-Server weist sie als unbekannt ab. Keine Legacy-Synchronisation reaktiviert.

**Metall** (`CENTRAL_UI_R6D_METAL_ACCOUNTING_CONTRACT_PINNED`). Kauf beim Lieferanten: eine Ausgabe der Kategorie
„Inventory" (Soll EXPENSES_OPERATING / Haben ACCOUNTS_PAYABLE) — dieselbe Einordnung wie jede Inventory-Ausgabe des Hauses;
Übersicht, Berichte und Ausgabenliste führen „Inventory" ausdrücklich als **kapitalisiert = Wareneinsatz**, nicht als
Betriebsausgabe (`CAPITALIZED_EXPENSE_CATEGORIES`). Das ist der kanonische, vereinfachte Vertrag und bleibt. Verkauf:
der vorhandene Vertrag ist die **Metallzahlung** (`metal_payments`, `postMetalPayment` Soll Kasse/Bank/Karte / Haben
REVENUE, `payment_status`), die Banking schon als Zufluss las — aber **kein Knopf rief sie**: „Mark Sold" schrieb nur
Status und Preis, weder Geld noch Erlös erschienen. **Korrigiert**: ein Verkauf mit Preis > 0 nennt den Zahlweg und bucht
die Metallzahlung in derselben Transaktion (bezahlt). Effekt gepinnt: Kauf Bestand +10 g · Wareneinsatz 300 an
Lieferant · kein Geld · kein Erlös; Verkauf Bestand −10 g · Kasse +450 · Erlös 450; Ergebnis 150; Einschmelzen ohne Buchung.
Vor R6D fehlte beim Verkauf der gesamte Geld- und Erlöseffekt.

**Gesellschafter-Saldo** (`CENTRAL_UI_R6D_PARTNER_DISTRIBUTION_SIGN_PINNED`). Der Saldo ist das **Kapitalkonto** des
Gesellschafters — so benennt ihn die Übersicht („Partner Capital", negative Salden als offene Auszahlung) und so bucht
das Hauptbuch: Einlage Haben PARTNER_EQUITY, Entnahme UND Gewinnauszahlung Soll PARTNER_EQUITY (beide gehen als Geld
hinaus). `partnerLedgerFor` zählte die Gewinnauszahlung als Plus — jede Auszahlung erhöhte das angezeigte Kapital, die
Bewegungsliste zeigte „+". **Korrigiert**: Saldo = Einlagen − Entnahmen − Gewinnauszahlungen == Hauptbuch PARTNER_EQUITY
des Gesellschafters; die Liste zeigt jede Auszahlung mit Minus. Gepinnt: Einlage 1000 → 1000; Gewinnauszahlung 100 → 900
(vorher angezeigt: 1100); Entnahme 200 → 700 — jeweils gleich dem Hauptbuch.

**Sync-Echo-Vertrag** (`CENTRAL_UI_R6D_SYNC_ECHO_CONTRACT_PINNED`): identisches eigenes Echo → kein Schreiben, keine
Fassung; echte Feldänderung → angewendet; Fremdänderung mit neuer Fassung → angewendet, Fassung übernommen; nur eine
abweichende Fassung oder nur ein neuer Zeitstempel → KEIN No-op (geschrieben); älterer Stand → unverändert „letzter Schreiber
nach Ankunft"; Löschen unverändert; über den vollen Dispatcher geprüft.

### Buchhaltung — Einordnung (`CENTRAL_UI_R6D_ACCOUNTING_CLASSIFICATION_PROVED`)

Frisch gegen den Code geprüft: in der SSOT gibt es **keine** offene A-Zeile, die eine normale tägliche Buchungsaktion
wäre. Nachbuchung (Backfill), Hauptbuch-Prüfstand, Reparatur-Abgleich und Hauptbuch-Rohsicht sind Werkzeuge des
Primary (`PrimaryOnlyNotice` an der Route), der Storno der Abstimmung erscheint nur am Primary. Sie bleiben
Primary-only und auf PC2 fail-closed; keine Umklassifizierung, keine Fernbuchung mit `backfill|ledger|reconcil`.

### Hauptbuch-Autorität und Atomarität (`CENTRAL_UI_R6D_LEDGER_AUTHORITY_PROVED`, `CENTRAL_UI_R6D_GOLD_SETTLEMENT_ATOMICITY_PROVED`)

Jede Buchung entsteht ausschließlich in der Hausfolge über die vorhandenen `postXxx`-Funktionen; kein Rumpf nennt Konto,
Soll/Haben, Summen, Salden, Reste, erfüllte Gramm, Spot, Schmelzwert, Belegnummer oder Status (Verbotslisten in allen
vier Befehlsmodulen). Jede neue Buchung ist ausgeglichen (Σ Soll = Σ Haben je Transaktion, in allen vier Tests geprüft).
Scheitert irgendein Schritt — Zeile, Gold-/Geldbestand, Buchung, Verknüpfung —, rollt die ganze Handlung zurück
(Fehlerinjektion an den Wirkungspunkten in allen vier Tests). Verlorene Antwort: dieselbe Kennung → dieselbe Antwort,
genau eine Wirkung. Änderbare Geld-/Goldzustände tragen eine Fassung (neu: `debts`, `expenses`,
`recurring_expense_templates`, `purchases`, `gold_payables`, `customer_gold_credits`, `precious_metals`; Schrott:
`version`); eine alte Fassung → `RECORD_CHANGED`, nichts geschrieben.

### Befund aus dem Zwei-App-Lauf: das Sync-Echo zählte die Fassung (`CENTRAL_UI_R6D_SYNC_ECHO_NO_REVISION_BUMP_PROVED`)

Der Primary synchronisiert (Auto-LAN) mit seinem eigenen Sync-Server und spielt dabei die Änderungen, die er selbst
hochgeschoben hat, beim nächsten Pull wieder ein (30-s-Takt). `applyUpsert` schrieb dafür ein UPDATE mit denselben
Werten — und jeder Fassungs-Trigger zählte +1. Wer einen Datensatz davor geöffnet hatte, bekam `RECORD_CHANGED`,
obwohl niemand etwas geändert hatte (gemessen: PC2 zahlt auf ein Darlehen, der Primary schiebt, PC2 zahlt noch einmal →
Nein). Das betraf seit C3D/C3E schon Rechnungen und Aufträge (auch über die Kindzeilen-Trigger) und seit R6D zusätzlich
die sieben neuen Fassungs-Tabellen. **Behoben an der Wurzel** (`core/sync/apply-change.ts`): stehen alle genannten
Spalten schon so in der Zeile, wird nicht geschrieben — ein Echo ohne Änderung ist keine Änderung. Jede echte Abweichung
schreibt wie bisher (letzter Schreiber nach Ankunft, unverändert). Bewiesen im Unit-Test (sieben Tabellen, Auftrag über
die Zeile, vorsichtiger Vergleich) und im Zwei-App-Lauf (Zahlung → Echo → zweite Zahlung geht durch, keine Fassung
bewegt sich).

### Befehlsmodell und Sicherheit (`CENTRAL_UI_R6D_FINANCIAL_INPUT_AUTHORITY_PROVED`)

Eine fachliche Absicht, ein Name: „Pay" an vier Stellen ist EIN `expenses.record_payment`; die fünf Abrechnungsarten des
Gold-Modals sind zwei Namen (je Gold-Topf, Art als Feld); Einlage/Entnahme/Gewinnverteilung ist `partners.record_tx`;
„Pausieren" ist `expenses.template_update` mit Zielwert; Verkaufen/Schmelzen ist `metals.update_status`. Rechte wie am
Primary: überall kein Tor außer `orders.add_cost`/`orders.remove_cost` (`perm.canManageOrders`). Negativ geprüft:
fremde Filiale, fremde Lieferanten/Kunden/Partner/Guthaben/Schulden, ungültige Gramm/Karat, negative Beträge,
Überzahlung/Übererfüllung, alte Fassung, abgeleitete Summen, direkte Ledger-Felder.

### Beweise

```
Unit    r6d/money 175/0 · r6d/payables 201/0 · r6d/gold 263/0 · r6d/metal-scrap 253/0 · r6d/final-gate 123/0
        r6d/sync-echo 25/0 · Sync-Nachbarn (cursor-safety, stale-replay, quarantine, identifier-apply, m2, m6b0, d3) grün
Nachbarn r6c final-gate/masterdata/inventory · r6b · r5c/r5d/r5e/r5f · c3g/c4/c6 · uiparity r2c/r3/r4b/r4c · manifest-drift grün
Rust    cargo test --lib bridge 37/0 · sync_schema 8/0 · TS app/node 0 · Lint-Delta 23 → 20
Two-App test/e2e/r6d-finance-gold.e2e.mjs 659/0 (6 min 39 s; nach dem Accounting-Gate neu gebaut und gefahren): alle 28 Buchungen auf PC2 UND am Primary, Zeilen/Status/Fassung/
        Hauptbuch Primary == PC2, verlorene Antwort ×6 (eine Wirkung), alte Fassung → RECORD_CHANGED, Überzahlung → Nein,
        alle Transaktionen ausgeglichen, Sync-Echo ohne Fassungssprung, PC2 ohne lokale DB, alte lataif.db unberührt,
        nur eigene Testprozesse beendet (Prozess-Isolation 35/0)
```

### Stand der R6A-SSOT nach R6D (`CENTRAL_UI_R6D_SSOT_UPDATED`)

```
A vorher             79
R6D Umfang           41   (Steuer 1 · Bank 1 · Gesellschafter 1 · Darlehen 3 · Ausgaben/Vorlagen 9 inkl. 3 Öffner ·
                           Einkauf 2 · Lieferant 4 inkl. 1 Öffner · Gold 10 · Kosten/Material 3 · Metall 4 · Schrott 3)
geschlossen          41
umklassifiziert       0   (Buchhaltungswerkzeuge waren nie A — sie bleiben Primary-only)
verbleibend          38
neue Buchungen       28
neue Auskünfte        3   (metals.spot_prices.get, debts.payments.get, suppliers.credits.get)
Registry            121 → 152   (1 Probe + 71 Auskünfte + 80 Buchungen)
```

Verbleibend (R6E/R6G): Angebote, Rechnungs-Lebenszyklus, Einkauf zurückgeben/stornieren, Auftrag stornieren +
Zeilenwege, Kommission, Transfer rückgängig, Produktion, Aufgaben, Dokumente/OCR, Nachrichtenprotokoll, Bildänderung,
Inbox-Foto.

## R6E — Verkauf, Angebote und Rechnungs-Lebenszyklus (13.09.2026)

Ein Bündel, vier Domänen: Angebote, Rechnungs-Lebenszyklus (anlegen + zahlen, Sondernummer, Butterfly, Retoure
stornieren), Rücknahme einer Transfer-Umwandlung und das Nachrichtenprotokoll am Kunden. Grundregel wie in R6D: **Primary
fachlich prüfen → Primary-Fehler in der gemeinsamen Domäne beheben → Fernbuchung auf dieselbe Domäne → Primary und PC2
gemeinsam testen.** Kein Primary-Fehler wurde in den Fernweg kopiert. R6F (Einkauf zurück/storno, Auftrag, Kommission,
Produktion, Bildänderung, Aufgaben, Dokumente, Inbox-Foto) bleibt vollständig offen.

### Umfang, eingefroren (`CENTRAL_UI_R6E_SCOPE_FROZEN`)

Aus der SSOT gelesen: **22 Einstiege** — Angebote 12 · Rechnung 4 · Transfer-Rücknahme 2 · Nachrichtenprotokoll 4.

| Domäne | UI-Einstiege (SSOT) | Laufweg am Primary vorher | Primary korrekt? | PC2 vorher | gemeinsame Domäne | Fernbuchung |
|---|---|---|---|---|---|---|
| Angebot | anlegen · speichern · Position hinzufügen/Preis/entfernen · senden/annehmen/ablehnen (Detail + Liste) | `offerStore` je Aktion ein Commit, Preis je Tastendruck, Folgen über den Ereignisbus | **nein**: keine Fassung, VAT_10-Preisänderung verlor die MwSt (line_total = netto), „offered"/Aufgaben NACH dem Commit und von PC2 nie, entfernter Artikel blieb „offered", stille Ersatzfiliale | TOT | `core/offers/offer-house` | `offers.create`, `offers.update`, `offers.set_status` |
| Angebot → Rechnung | Create Invoice | `createInvoiceFromOffer` — ein ZWEITER Rechnungsweg | **nein**: Einstand aus `products.purchase_price` statt Los, verschluckte Buchung, Artikel ohne Produktzeile still weg, Los-Artikel ohne offenes Los ohne Bestandsabzug | TOT | offer-house → `createDirectInvoice` (+ `offerId`) | `offers.convert_to_invoice` |
| Rechnung | anlegen mit Zahlung | `createDirectInvoice` + `recordPayment` lose hintereinander | **nein**: scheiterte die Zahlung, blieb eine unbezahlte Rechnung (Bestand + PINV verbraucht) | ehrliches Nein | `core/invoices/invoice-create-house` | `invoices.create` (+ `payment`) |
| Rechnung | Schlusszahlung mit Sondernummer | `recordPayment(…, specialMarkOnFinal)` ohne Klammer | **nein**: verschluckte Buchung/Kartengebühr | ehrliches Nein | `core/invoices/invoice-payment-house` | `invoices.record_payment` (+ `specialMarkOnFinal`) |
| Rechnung | Butterfly | allgemeines `updateInvoice` (kann Status/Beträge/Nummer schreiben) | eng genug nur durch die Maske | TOT | `core/invoices/invoice-flag-house` | `invoices.set_butterfly` |
| Retoure | Retoure stornieren | `cancelReturn` mit eigener Klammer | **nein**: Owner aus der Primary-Anmeldung, Retoure aus der geladenen Liste, Audit mit Sitzungsbenutzer, Rechnung blieb RETURNED | TOT | `core/returns/return-cancel-house` | `returns.cancel` |
| Transfer | Umwandlung rückgängig (Tabelle, Detail) | `undoTransferInvoiceConvert` → `deleteInvoice` | **nein**: Rechnung HART gelöscht, die Verkaufsforderung an den Agenten kam nie zurück | TOT | `core/invoices/invoice-reversal` + `transfer-house` | `transfers.undo_convert` |
| Nachrichten | Kopieren · WhatsApp · AI-Benachrichtigung (Auftrag, Reparatur) | `logMessage`, Fehler → stilles `null` | **nein**: keine Prüfung von Kunde/Verknüpfung/Filiale, Ersatzfiliale, stilles Nichts | ehrlich „nicht protokolliert" | `core/customers/message-house` | `customers.log_message` |

### Primary zuerst — Befunde und Behebung (`CENTRAL_UI_R6E_PRIMARY_FIRST_PROVED`)

Jede Befund-Zeile ist in der gemeinsamen Domäne behoben; der Primary läuft seither über `runOnPrimary` (Schreibreihenfolge,
eine Ledger-Transaktion, erst danach durabel), PC2 über `runRemoteCommand` — **dieselbe** Hausfolge. Die Store-Aktionen
des Primary (`createOffer`, `createInvoiceFromOffer`, `cancelReturn`, `undoTransferInvoiceConvert`, `logMessage`) sind
nur noch Anschlüsse an die Hausfolge. Buchungen in Hausfolgen sind streng: wo ein Store-Schreiber `safePost` benutzt,
wacht `watchLedgerPosts` — ein gescheiterter Post nimmt die ganze Handlung zurück.

- **Angebot — Fassung** (`CENTRAL_UI_R6E_OFFER_REVISION_PROVED`): `offers.revision` mit Trigger; jede Positionsänderung
  hebt die Fassung des Angebots (wie `order_lines` → `orders`). „Speichern" ist EINE fachliche Handlung: Kopf und
  vollständiger Positionsstand zusammen; Hinzufügen/Ändern/Entfernen leitet der Primary aus den Zeilen-IDs ab. Die Maske
  arbeitet im Entwurf (kein Schreiben je Tastendruck). Veraltet → `RECORD_CHANGED`, nichts geschrieben; unverändert → keine
  neue Fassung. Nur ein Entwurf ist bearbeitbar (`OFFER_NOT_EDITABLE`); Übergänge nur draft → sent → accepted/rejected.
- **Angebot — Folgen atomar**: „offered" beim Anlegen/Hinzufügen, zurück auf Lager beim Ablehnen/Entfernen, Nachfass- und
  „Create invoice"-Aufgabe entstehen IN der Transaktion; die Ereignis-Handler dafür sind entfernt (kein Doppel).
- **Angebot → Rechnung** (`CENTRAL_UI_R6E_OFFER_TO_INVOICE_ATOMIC_PROVED`): kein zweiter Rechnungsweg mehr. Die Zeilen
  entstehen mit derselben Ableitung wie das Rechnungsformular (`toInvoiceLine`, Einstand aus dem FIFO-Los), die Rechnung
  über `createDirectInvoice` (`offer_id` im selben INSERT); Angebotsstatus und -verknüpfung in derselben Transaktion.
  Bewiesen: gleiche Zeilen und Buchung wie das Formular; Fehlerinjektion an Buchung, Angebots-UPDATE, Aufgabe → keine halbe
  Rechnung, Los und PINV-Zähler unverändert; verlorene Antwort → genau eine Rechnung; Doppelumwandlung abgewiesen.
- **Anlegen + Zahlen**: eine Hausfolge, eine Transaktion. Der Primary entscheidet Summen, Steuer, Einstand, Forderung,
  Zahlungszuordnung, Kartengebühr, Endnummer, Buchung, Filiale. Überzahlung beim Anlegen bleibt abgewiesen
  (`PAYMENT_EXCEEDS_TOTAL`) — die bestehende Regel des Formulars („Überzahlung läuft über die Rechnungsseite").
- **Sondernummer** (`CENTRAL_UI_R6E_SPECIAL_NUMBER_CONTRACT_PROVED`): eine ECHTE Belegnummer aus einem eigenen durablen
  Zähler (SINV, bei Reparaturen SRINV), vergeben vom Primary in derselben Transaktion; der normale Kreis (INV/RINV) bleibt
  unberührt und umgekehrt; zwei Finalisierungen → zwei verschiedene Nummern; eine verlorene Antwort verbraucht keine zweite.
  Der Client schickt nie eine Nummer, nur die WAHL (`specialMarkOnFinal`); sie wirkt nur auf der Zahlung, die die Rechnung
  schließt (sonst bleibt die Marke vom Anlegen) — genau wie am Primary. Wählen darf, wer die Zahlung erfassen darf.
- **Butterfly**: eigene enge Handlung (nur die Spalte), Fassung, stornierte Rechnung → `INVOICE_CANCELLED`; gleicher Wert
  schreibt nichts.
- **Retoure stornieren** (`CENTRAL_UI_R6E_RETURN_CANCEL_PROVED`): der vollständige Effekt bleibt (Bestand/Disposition,
  Rechnungs-MwSt, SALES_RETURN_COGS- und CREDIT_NOTE-Storno, Kartengebühr-Erstattung zurück, REJECTED, Audit atomar); das
  Recht und das Audit gelten für den AUTHENTIFIZIERTEN Absender (zentral `isOwner`, zusätzlich in der Hausfolge), nicht
  für die Anmeldung am Primary. Die Rechnung kehrt von RETURNED auf PARTIAL zurück, wenn ihre Forderung wieder offen ist.
  Die Hausfolge rollt nie selbst zurück (ein ROLLBACK dort hätte die äußere Transaktion des Fernauftrags zerstört).
  PC2 sieht die Stornierbarkeit über die vorhandene Auskunft `store.sales_returns.get` (`cancelability`).
- **Transfer-Rücknahme** (`CENTRAL_UI_R6E_TRANSFER_UNDO_ATOMIC_PROVED`): kein Löschen mehr. Die gemeinsame Grundlage
  `reverseInvoiceInHouse` storniert die Rechnung mit der bestehenden Storno-Semantik (Lose, Buchungsstorno, Zahlungen,
  Auto-Ausgaben, Verknüpfungen) — der Beleg bleibt als CANCELLED stehen; R6F kann sie für den Kommissions-Storno
  wiederverwenden. Danach werden alle Transfers derselben Rechnung auf ihren Stand VOR der Umwandlung gesetzt und die
  Verkaufsforderung an den Agenten wird neu gebucht (die Umwandlung hatte sie storniert). Bewiesen: vor Umwandlung ==
  nach Umwandlung + Rücknahme (Transfer, Artikel, Lose, Saldo je Konto und Gegenpartei), auch bei Sammelrechnungen;
  Fehler zwischen Rechnungsstorno und Transfer-Rückstellung → vollständiger Rollback. Bezahlte Rechnung → abgewiesen
  (bestehende Regel). „Rechnung löschen" bleibt Kategorie E am Primary.
- **Nachrichtenprotokoll** (`CENTRAL_UI_R6E_MESSAGE_LOG_PROVED`): die vier Einstiege sind EINE Absicht →
  `customers.log_message`. Kunde und Verknüpfung (Angebot/Auftrag/Reparatur) müssen in der Filiale existieren; Filiale,
  Absender (`created_by`) und Zeitpunkt entscheidet der Primary; nur anhängend, Idempotenz über die Kennung.

**Bewusst belassen (Befunde, eigene Entscheidung nötig):**
- (Beide früheren Befunde — Gutschrift beim Retourenstorno gelöscht, Urheber von Fernbuchungen = Anmeldung am Primary —
  sind im Audit-Integrity-Gate unten behoben.)
- Angebot rechnet mit dem Filial-MwSt-Satz, die Rechnung mit `vatRateFor(scheme)` (bei Standard 10 % identisch).
- Eine als Store-Guthaben erstattete Retoure bleibt unstornierbar (Sperre „refund paid"); nach dem Storno einer Retoure an
  einer unbezahlten Rechnung steht der Artikel auf „sold" statt „reserved" (`revertDisposition`).

### Audit-Integrity-Gate (13.09.2026)

**Absender von Fernbuchungen** (`CENTRAL_UI_REMOTE_ACTOR_ATTRIBUTION_PROVED`). Befund, systemisch seit C3B: jede
Fernbuchung, deren Hausfolge über die alten Store-Schreiber läuft (Rechnung, Zahlung, Gutschrift, Retoure, Auftrag,
Kommission, Reparatur, Transfer, Einkauf — C3B bis C3H, R5*, R5F.1 und die R6E-Rechnungswege), schrieb `created_by`,
`ledger_entries.created_by` und `audit_log.changed_by` mit `currentUserId()` — also mit der ANMELDUNG AM PRIMARY, nicht
mit dem geprüften Absender von PC2. Die R6C/R6D-Hausfolgen mit eigenem Kontext aus `identity` waren schon richtig.
**Behoben an EINER Stelle**, nicht je Befehl: `runRemoteCommand` führt den Handler im Namen von `identity.userId` aus
(`core/auth/acting-user`), `currentUserId()` fragt zuerst den laufenden Fernauftrag, sonst die Anmeldung am Primary.
Lokale Handlung am Primary → Anmeldung am Primary; Fernauftrag → authentifizierter Absender; kein Rumpf nennt den Urheber
(`createdBy`/`userId`/`created_by`/`actor` werden abgewiesen). Nach Erfolg, Urteil oder Störung — auch über ein `await`
hinweg — gilt wieder die Anmeldung am Primary. **Alte Zeilen bleiben unverändert**: ihre wirkliche Urheberschaft ist
nicht beweisbar (der durable Nachweis nennt den Absender, aber nicht jede daraus entstandene Zeile), also wird nichts
nachträglich umgeschrieben.

**Gutschrift beim Retourenstorno** (`CENTRAL_UI_R6E_CREDIT_NOTE_REVERSAL_PROVED`). Eine ausgestellte Gutschrift wird nicht
mehr gelöscht: Migration `credit_notes.status` (`ISSUED`/`CANCELLED`, Vokabular wie Rechnung/Ausgabe/Einkauf) mit
`cancelled_at`, `cancelled_by`, `cancel_reason`; unbenutztes Guthaben daraus wird `customer_credits.status = 'CANCELLED'`.
Nummer und Identität bleiben; die Hauptbuch-Umkehr (`CREDIT_NOTE`) bleibt die finanzielle Wahrheit; je Gutschrift ein
eigener Protokolleintrag (Mensch und Zeit) in derselben Transaktion; der Abgleich trägt die Zeilen als Änderung.
Alle Leser geprüft: Summen und Zählungen (offener Betrag, Kundensaldo und -guthaben, Forderungen, Abstimmung,
Gegenpartei-Prüfung, Deckel neuer Gutschriften, Rechnungsstorno M-04, Guard B, `requireNoReturns`, Nachbuchung,
Kommissions-Storno, Rechnungsseite) lassen `CANCELLED` weg — dieselbe Wirkung wie früher das Löschen; Steuer/Quartal/NBR
lesen `credit_notes` gar nicht (MwSt aus `invoices.vat_amount`, das der Storno wiederherstellt). Liste und Detail zeigen
die stornierte Gutschrift sichtbar markiert; Löschen einer stornierten Gutschrift ist gesperrt. Wiederholung → genau
einmal (fern eingefrorenes `RETURN_ALREADY_CANCELLED`); Fehlerinjektion an Status, Guthaben, Protokoll, Buchung → nichts.

**Vertrag: eine bereits erstattete Retoure** (`CENTRAL_UI_R6E_PAID_REFUND_CANCEL_CONTRACT_PINNED`). Bestehende Regel,
unverändert und jetzt gepinnt: ist auf die Retoure eine Erstattung verbucht (`sales_returns.refund_paid_amount > 0`), gibt
es keinen Storno. Das gilt für Bargeld/Bank/Karte UND für ein Store-Guthaben, das über „Refund" als Erstattung gebucht
wurde (`recordRefundPayment(…, 'credit')`, refund_status REFUNDED, Buchung CR CUSTOMER_CREDIT). Oberfläche: statt
„Cancel Return" steht „Cannot cancel: A refund of … has already been paid out — reclaim it first." (dieselbe Regel
`returnCancelability`, auf PC2 über `store.sales_returns.get`). Domäne: `RETURN_REFUND_PAID_OUT` am Primary, fern ein
eingefrorenes Nein. Wirkung: keine — Retoure, Gutschrift (bleibt ISSUED), Guthaben (bleibt OPEN), Hauptbuch, Zahlungen,
Protokoll unverändert; die verbuchte Erstattung selbst bleibt stehen. Einen Rückholweg gibt es nicht und R6E erfindet
keinen. Stornierbar bleibt, was noch nicht als Erstattung verbucht ist (freigegebene Gutschrift, auch mit Guthaben).

**Leser der Gutschriften** (`CENTRAL_UI_R6E_CREDIT_NOTE_READER_CLASSES_PINNED`): jede Datei, deren Code `credit_notes` nennt,
ist eingeordnet (18: Summen/Zählungen ohne CANCELLED, Verweise auf lebende Retouren, Storno, Liste mit Löschsperre,
Schema, Abgleich). **NOT A CONSUMER**: Steuer/Quartal (`financeFor`), NBR-Export (`InvoiceList`), Umsatzkennzahlen
(`sales-metrics`, `sales-metrics-loader`), Hauptbuch-Abfragen/`vatPosition` — die MwSt kommt aus
`invoices.vat_amount`, das der Storno wiederherstellt; keine neue Buchhaltungssemantik. Gepinnt: eine ausgestellte
Gutschrift wirkt wie bisher (offene Posten, Forderungen, Kunden-Gutschriften, Hauptbuch), eine stornierte wirkt nicht
mehr (jeder Leser wie vor der Retoure), bleibt aber mit Nummer, Status und Storno-Urheber in der Liste; Löschen gesperrt.

**Zwei verschiedene Benutzer, zwei echte Anwendungen** (`CENTRAL_UI_R6E_DISTINCT_ACTOR_E2E_PROVED`): Primary als A, PC2 als
B — Rechnung mit Zahlung, Teilzahlung auf eine offene Rechnung, Retourenstorno. Wirkung gleich; alle neuen Urheber-Spalten
und Protokolleinträge der PC2-Handlung = B, der Primary-Handlung = A; der Primary bleibt als A angemeldet; ein Rumpf mit
fremdem Urheber wird abgewiesen; PC2 bleibt ohne Datenbank. Ergebnis: 123/0 (1m 32s; Primary user-owner, PC2 user-r6e-b).

### Befehlsmodell, Rechte und Sicherheit (`CENTRAL_UI_R6E_AUTHORITY_PROVED`)

Acht neue Buchungen, zwei vorhandene erweitert: `offers.create/update/set_status/convert_to_invoice`,
`invoices.set_butterfly`, `returns.cancel`, `transfers.undo_convert`, `customers.log_message`; `invoices.create`
(+ `payment`) und `invoices.record_payment` (+ `specialMarkOnFinal`). Rechte wie am Primary: `offers.update` hinter
`perm.canEditOffers`, `invoices.set_butterfly` hinter `perm.canEditInvoices`, `returns.cancel` nur Eigentümer (neue
Regelart `isOwner`), der Rest ohne Tor wie die Maske. Negativ geprüft: fremde Filiale, fremde Angebote/Rechnungen/
Retouren/Transfers/Kunden, veraltete Fassung, vom Client gesendete Summen/Einstand/Steuer/Buchungswerte, Belegnummern,
direkte Statusinjektion, unzulässige Übergänge und Stornozustände, fremder bzw. nicht berechtigter Absender.

### Beweise

```
Unit    r6e/offer 168/0 · r6e/invoice-lifecycle 134/0 · r6e/reversal 146/0 · r6e/message-log 98/0 · r6e/final-gate 99/0
        r6e/actor-attribution 37/0 · r6e/credit-note-reversal 161/0 (Audit-Integrity-Gate + Vertrags-Pin)
Nachbarn r6d/r6c final-gate · r6b · r5c/r5d/r5e/r5f · c3g/c4/c6 · bridge invoice/remote-create/financial/lifecycle/service/write-foundation/client-ui · uiparity r1/r2c/r3/r4b/r4c — 41 Dateien grün
Rust    cargo test --lib bridge 37/0 · sync_schema 8/0 · manifest-drift 1443/1443 · TS app/node 0 · Lint-Delta 0
Two-App test/e2e/r6e-sales-offers-invoice.e2e.mjs 386/0 (4m 26s) · Zwei-Benutzer test/e2e/r6e-actor-attribution.e2e.mjs 123/0 (1m 32s; Primary user-owner, PC2 user-r6e-b)
```

### Stand der R6A-SSOT nach R6E (`CENTRAL_UI_R6E_SSOT_UPDATED`)

```
A vorher             38
R6E Umfang           22   (Angebote 12 · Rechnung 4 · Transfer-Rücknahme 2 · Nachrichtenprotokoll 4)
geschlossen          22
umklassifiziert       0
verbleibend          16
neue Buchungen        8   (+ 2 vorhandene erweitert: invoices.create, invoices.record_payment)
neue Auskünfte        0   (Stornierbarkeit reist in store.sales_returns.get)
Registry            152 → 160   (1 Probe + 71 Auskünfte + 88 Buchungen)
```

Verbleibend (R6F, vollständig offen): Rückgabe an Lieferant, Einkauf stornieren, Inbox-Foto verwerfen, Auftrag stornieren
(mit Geld), Zeilenstatus ×2, Position bearbeiten (Auftrag), beim Lieferanten bestellt, Produktion anlegen, Kommission
Rückgabe nach Verkauf / Verkauf stornieren, Bildänderung am Artikel, Aufgabe anlegen/ändern, Aufgabe erledigt, Dokument
hochladen, Texterkennung.

## R6F — Einkauf, Auftrag, Kommission, Produktion, Bilder, Büro (13.09.2026)

Die letzten 16 offenen A-Einstiege. Grundregel wie R6D/R6E: **Primary fachlich prüfen → Primary-Fehler in der gemeinsamen
Domäne beheben → Fernbuchung auf dieselbe Domäne → Primary und PC2 gemeinsam testen.** „Auftrag löschen" und alle
anderen Löschknöpfe bleiben Kategorie E am Primary; C/D/E werden nicht als geschlossen ausgegeben.

### Umfang, eingefroren (`CENTRAL_UI_R6F_SCOPE_FROZEN`)

Einkauf 3 · Auftrag 5 · Kommission 2 · Produktion 1 · Bildänderung 1 · Aufgaben 2 · Dokumente/OCR 2 = **16**.

### Primary zuerst — Befunde und Behebung (`CENTRAL_UI_R6F_PRIMARY_FIRST_PROVED`)

- **Einkauf** (`CENTRAL_UI_R6F_PURCHASE_RETURN_PROVED`, `CENTRAL_UI_R6F_PURCHASE_CANCEL_ATOMIC_PROVED`,
  `CENTRAL_UI_R6F_PURCHASE_INBOX_PROVED`): „Rückgabe an Lieferant" war zwei Aufrufe mit zwei Speichervorgängen und
  verschluckter Buchung; verkaufte Ware ließ sich zurückgeben (Lager im Hauptbuch negativ), eine Rückgabe über der
  Einkaufssumme wurde still gekappt, Benefit-Erstattung buchte auf BANK. Jetzt EINE Hausfolge
  (`core/purchases/purchase-lifecycle-house`), `PURCHASE_RETURN_STOCK_UNAVAILABLE` / `…_EXCEEDS_PURCHASE`, Teilrückgabe
  wie bisher. „Einkauf stornieren" buchte über `safePost`, las die geladene Liste und ließ eine bestätigte Retoure stehen;
  jetzt strikt, aus der Datenbank, Retoure umgekehrt und CANCELLED, Lose/Artikel/Auftragszeilen/Guthaben zurück, Beleg
  und Zahlungen bleiben (`cancelPurchaseInHouse`, auch vom Kommissions-Storno genutzt). „Inbox-Foto verwerfen" ist ein
  einseitiger Übergang `pending → dismissed` (das Foto liegt inline in `purchase_inbox.images`, kein Media-Root, kein GC-
  Verbraucher); ein schon übernommenes Foto (`done`) wird nicht mehr umgekippt.
- **Auftrag** (`CENTRAL_UI_R6F_ORDER_CANCEL_PROVED`, `CENTRAL_UI_R6F_ORDER_LINE_LIFECYCLE_PROVED`,
  `CENTRAL_UI_R6F_ORDER_MARK_ORDERED_PROVED`, `CENTRAL_UI_R6F_ORDER_LINE_EDIT_PROVED`): der Storno buchte über `safePost`,
  zahlte umgewandelte Anzahlungen ein zweites Mal aus, verlor die Guthaben-Notiz, und „Delete Order" nach dem Storno kehrte
  die Anzahlungen doppelt um. Jetzt EINE Hausfolge (`core/orders/order-lifecycle-house`); der Auftrag bleibt als
  stornierter Beleg. **Der Artikel beim Storno** entsteht nur bei einem Sonderauftrag mit angefangener Arbeit (gebuchte A/P
  an den Goldschmied, Kostenbasis > 0) — die Maske verspricht ihn ausdrücklich („The piece is created as a stock
  product"), die Schuld bleibt offen: fachlich nötig, jetzt atomar statt verschluckt. Zeilenstatus ist EINE Übergangs-
  Buchung (PENDING/ARRIVED/DELIVERED, „Undo" = PENDING); ARRIVED/DELIVERED buchen die A/P jetzt strikt und atomar mit dem
  Status. „Beim Supplier bestellen" ist ein reiner Marker (ORDERED + geplanter Lieferant, kein Geld/Bestand/Schuld).
  „Position bearbeiten": nur echte Eingaben, Rest/Summe/Marge vom Primary, ein neuer Artikel atomar, Überzahlung wird
  Guthaben.
- **Kommission** (`CENTRAL_UI_R6F_CONSIGNMENT_RETURN_PROVED`, `CENTRAL_UI_R6F_CONSIGNMENT_CANCEL_SALE_ATOMIC_PROVED`):
„Rückgabe nach Verkauf" nahm den Nettopreis (bei VAT_10 blieben Forderung/Umsatz in Höhe der Steuer als Phantom),
  zog die Retourennummer aus der Uhrzeit, führte die Barerstattung nicht an der Retoure, ließ den Wareneinsatz gebucht
  (INVENTORY/COGS schief) und verschluckte Einkaufs- und Verluststorno. Jetzt über die vorhandene Retouren-Hausfolge
  (`createReturnInHouse` + Freigabe + Erstattung, Brutto, durabler Zähler, `SALES_RETURN_COGS`); „Return to Owner"
  steht danach auf 0 je Konto. „Verkauf stornieren" — der höchste Risikopfad — LÖSCHTE Gutschrift und Retoure hart,
  stornierte die Rechnung am vorgesehenen Weg vorbei und verschluckte vier Teilschritte. Jetzt EINE Transaktion
  (`core/consignment/consignment-reversal-house`): eigene Retoure über `cancelReturnInHouse` (Gutschrift CANCELLED,
  Retoure REJECTED), Rechnung über die R6E-Grundlage `reverseInvoiceInHouse`, Auto-Einkauf über `cancelPurchaseInHouse`,
  Verlust und Auszahlungen an den Einlieferer umgekehrt, Artikel zurück in den Kommissionsbestand, Protokoll mit dem
  Absender. Bewiesen: Stand vor dem Verkauf je Konto und Gegenpartei; Fehlerinjektion nach dem Rechnungsstorno, nach der
  Einliefererseite, nach dem Bestand, vor dem Commit und an einer Buchung → nichts. Eine bar erstattete Rückgabe nach
  Verkauf sperrt den Verkaufsstorno (`RETURN_REFUND_PAID_OUT`, R6E-Regel).
- **Produktion** (`CENTRAL_UI_R6F_PRODUCTION_PROVED`): ohne Transaktion, Eingänge ungeprüft (fremde Filiale, verkauft,
  verbraucht), mehrstückige Eingänge still ganz verbraucht, Ergebnis-Bilder als JSON an `products.images` vorbei am
  Medienweg, stille Ersatzfiliale. Jetzt EINE Hausfolge (`core/production/production-house`), Ergebnisse über
  `createProductWithMedia` (Zwischenablage → Medienspeicher), Protokoll atomar; keine Buchung beim Anlegen (wie bisher).
- **Bildänderung** (`CENTRAL_UI_R6F_PRODUCT_MEDIA_PROVED`): die vorhandene Buchung `products.update` mit Galerie-Plätzen
  (`{keep: mediaId}` / `{stagingId}`); PC2 bekommt die Kennungen schon über `products.get` — keine neue Auskunft.
  Behoben: `products.update` prüfte die Filiale nicht.
- **Aufgaben/Dokumente** (`CENTRAL_UI_R6F_TASKS_PROVED`, `CENTRAL_UI_R6F_DOCUMENTS_OCR_PROVED`): Aufgaben ändern ohne
  Filiale/Fassung/Vokabular, „Erledigt" doppelt möglich; jetzt `tasks.create` + `tasks.update` (Erledigen = Status) mit
  Fassung. Dokumente: **Grenze abgeleitet, nicht erfunden** — die Zeile reist als ganzes JSON in den Abgleich, jeder andere
  Rechner verwirft über `max_payload_bytes` (33 554 432); also Zeile ≤ diesem Wert, Datei ≤ 25 116 672 B (Vertrag: R6F FINAL unten); Typ aus dem
  Inhalt (Signatur), Dateiname ohne Pfadtrenner/Traversal, Verknüpfung in der Filiale. **Texterkennung** ist eine
  synchrone Mutation mit gespeichertem Ergebnis: der PRIMARY erkennt aus SEINEM gespeicherten Inhalt (Rumpf nur
  `documentId` + Fassung), Fassung vor und nach der Erkennung geprüft, eine Wiederholung erkennt nicht erneut; der
  fehlende Abgleich-Eintrag ist behoben.

- **Medienaufnahme (gemeinsamer Rust-Kern, im Zwei-Rechner-Lauf gefunden):** am Primary scheiterten Bildaufnahmen
  (Artikelbild, Produktionsergebnis, auch der rein lokale Speichern-Weg) zeitweise mit `MEDIA_IO_ERROR`: das Ersetzen des eben
  verlinkten Aufnahme-Journals fand die Datei länger als die Frist von 0,8 s belegt (Echtzeitschutz von Windows Defender aktiv;
  Journal blieb `preparing`, beide Bilddateien vollständig daneben — sauber, aber für den Benutzer ein Fehlschlag). Behoben in
  `media/storage.rs`: die Wiederholung bei ERROR_ACCESS_DENIED/ERROR_SHARING_VIOLATION ist jetzt eine Zeitfrist (3 s je Schritt,
  Pausen bis 100 ms), weiterhin nur für Ersetzen und Verlinken; `io_err` behält den Betriebssystem-Code (`io:PermissionDenied:os5`).
  Bestand seit CENTRAL-C5, kein R6F-Code.

**Bewusst belassen (Befunde, eigene Entscheidung nötig):** `completeRecord` (Arbeits-/Gemeinkosten) ist über die
Oberfläche nicht erreichbar — eigener Produktfehler nach der Parität (R6F FINAL §5) · die Überzahlungs-Gutschrift eines
stornierten Auftrags wird weiter gelöscht (gemeinsamer Helfer `clawbackGrantedCredit`) · `production_inputs`/
`production_outputs` stehen nicht im Abgleich-Manifest · das Notizfeld der Aufgabenmaske hat keine Spalte · große Dokumente
können das 20-s-Brückenlimit reißen (Wiederholung mit derselben Kennung ist sicher). Texterkennung, Dokumentgröße,
Gold-Schulden beim Auftragsstorno und Lieferantenguthaben: geklärt in R6F FINAL.

### R6F FINAL — Funktionsabschluss

1. **Texterkennung läuft** (`CENTRAL_UI_R6F_OCR_RUNTIME_PROVED`). Befund: tesseract.js 7.0.0 holte Worker (`worker.min.js`),
   Kern (`tesseract-core-*-lstm.wasm.js`, Wahl nach SIMD) und die Sprachdaten `eng`+`ara` (`4.0.0_best_int`, LSTM, OEM 1)
   von `cdn.jsdelivr.net` und legte sie in IndexedDB ab; die CSP ließ schon den Worker nicht laden — OCR lief nie in der App.
   Jetzt liefert die App fünf Dateien unter `/ocr/` selbst aus (`core/ai/ocr-assets.ts`, Vite-Plugin in `vite.config.ts`,
   Sprachpakete `@tesseract.js-data/eng`/`ara` exakt 1.0.0): der Worker-Eingang `ocr-worker.js` (lässt nur denselben Ursprung
   zu — `fetch`/`importScripts` zu einem fremden Host wirft `OCR_OFFLINE_ONLY`, denn `connect-src` erlaubt https: für andere
   Teile), `worker.min.js`, `tesseract-core-simd-lstm.wasm.js`, `eng.traineddata.gz`, `ara.traineddata.gz` — zusammen
   8,23 MiB mehr. CSP unverändert, Sprachen unverändert, kein IndexedDB-Cache (`cacheMethod: 'none'`). Der Primary erkennt
   aus SEINEM gespeicherten Dokument; PC2 schickt nur `documentId` + Fassung (verlorene Antwort → eingefrorenes Ergebnis,
   keine zweite Erkennung, kein zweites Dokument).
2. **Dokumentgröße** (`CENTRAL_UI_R6F_DOCUMENT_SIZE_CONTRACT_PINNED`). Schichten: Rohbytes → Base64 (4 Zeichen je angefangene
   3 Bytes) → Zeile als JSON (`trackChange`, `SELECT *`) ≤ `max_payload_bytes` 33 554 432 (Rust: Bytes; `apply-change`:
   Zeichen) → Push-Umschlag (maskiert nur `"`/`\`) ≤ 50 MiB Körpergrenze; `/api/command` von PC2 hinter derselben Grenze.
   Größte Datei **25 116 672 B** = ⌊(33 554 432 − 65 536) / 4⌋ × 3: die Reserve von 64 KiB trägt Kopf (≤ 512 Zeichen), Name
   (≤ 255 Zeichen), Typ (≤ 255), Verknüpfung (≤ 255), die übrigen Spalten (< 4 KiB) und ≥ 60 KiB erkannten Text. Die alte
   Angabe „24 MiB" war nie erreichbar (ihr Base64 allein füllte die Zeile). Geprüft: größte Datei mit den längsten Angaben
   angenommen (Primary und PC2, Empfänger nimmt die Zeile an, Umschlag < 50 MiB); ein Byte mehr → `DOCUMENT_TOO_LARGE` vor
   jeder Arbeit, nichts geschrieben; ein Text, der die Zeile um 1 Byte überschritte → abgewiesen, alter Text bleibt.
   **Gefunden und behoben:** der Push schickte bis zu 100 Änderungen in EINEM Rumpf — zwei große Dokumente überschritten die
   50 MiB (413), und jeder weitere Push scheiterte an denselben Einträgen. `sync/push-batch.ts` schneidet den Stapel jetzt
   nach Bytes (kleine Stapel unverändert, Reihenfolge bleibt).
   **Draht-Nachweis** (`CENTRAL_UI_R6F_DOCUMENT_WIRE_SIZE_PROVED`): die Abgleich-Zeile ist Byte für Byte `JSON.stringify(SELECT *)`
   — dieselbe Serialisierung, die das Haus vor dem Quittieren misst; Upload UND Texterkennung prüfen exakt Zeile (≤ 32 MiB)
   und Push-Umschlag dieser einen Änderung (≤ 50 MiB). Der feste Wert 25 116 672 allein reicht nach OCR nicht: ein Text voller
   Anführungszeichen (13,5 Mio.) hält die Zeile unter 32 MiB, den Umschlag aber über 50 MiB — jetzt `DOCUMENT_TOO_LARGE`,
   nichts geschrieben. **Sync-Aufteilung** (`CENTRAL_UI_R6F_SYNC_SIZE_BATCHING_PROVED`, echte `pushChanges`): zwei große
   Dokumente → zwei Rümpfe, jeder ≤ 50 MiB inkl. Umschlag; kleine weiter 100 je Push in Reihenfolge; Ablehnung → nichts
   quittiert, Wiederholung = derselbe Stapel. **Gefunden und behoben:** eine Änderung, die der Primary NIE annimmt (Daten
   > `max_payload_bytes` oder allein ein Rumpf > 50 MiB — z. B. ein Alt-Dokument von vor R6F), stand für immer vorn und
   blockierte jede spätere; jetzt wird sie nicht gesendet, bleibt als `synced = 2` stehen (die Aufräumung löscht nur
   `synced = 1`), mit Warnung — die nächste Änderung geht im selben Push.
   **Medien-Wiederholung** (`CENTRAL_UI_R6F_MEDIA_TRANSIENT_RETRY_PINNED`): nur Windows 5/32 beim Ersetzen/Verlinken, 3 s;
   jeder andere Code (2, 3, 19, 21, 80, 112, 183, 1224, NotFound, AlreadyExists) scheitert beim ersten Aufruf mit seinem Code.
3. **Auftragsstorno und Gold** (`CENTRAL_UI_R6F_ORDER_GOLD_CANCEL_CONTRACT_PINNED`). Die Gramm-Schuld an den Goldschmied
   entsteht aus der Extra-Gold-Kostenzeile (`order-house` → `insertGoldPayable`) oder aus „Add Cost" (Zeile gleich ARRIVED).
   Vorher stornierte der Auftragsstorno JEDE offene Schuld — auch geliefertes und teilweise beglichenes Gold. Jetzt eine
   Regel (`goldPayableSurvivesCancel`, Store = Haus für Primary und PC2): reine Planung → CANCELLED; geliefert oder Gramm
   bewegt → bleibt OFFEN (`openGoldPayableIds`), die Maske zeigt beides getrennt. Gold des Kunden ist keine Schuld (nur
   Notiz). Vertrag: geplant / geliefert / teilweise beglichen, Goldbestand und Hauptbuch (ausgeglichen) — 35/0.
4. **Lieferantenguthaben** (`CENTRAL_UI_R6F_SUPPLIER_CREDIT_REVERSAL_CONTRACT_PINNED`): **Klasse B**, operative Saldozeile —
   keine Nummer, kein Druck/Export, keine Detailansicht; die Überzahlungszeile wird bei jeder Neuberechnung neu angelegt.
   Die Historie steht in Einkauf/Retoure (CANCELLED), Hauptbuch (Original + Storno) und Protokoll (CREATE/DELETE); alle
   elf Leser zeigen vorher und nachher denselben Saldo. Eine aktive Einlösung sperrt jede Rückabwicklung
   (`PURCHASE_RETURN_CREDIT_USED`/`PURCHASE_OVERPAY_CREDIT_REDEEMED`). Gepinnter Rest: nach einer STORNIERTEN Einlösung zeigt
   die stornierte Zahlung auf die gelöschte Zeile — die Abstimmung meldet `bad_reference` (Salden richtig; über Maske und
   PC2 nicht erreichbar, nur die Store-Altwege `cancelReturn`/`deleteReturn` ohne Aufrufer). Vertrag 48/0.
5. **Produktionsabschluss — Post-Parity-Produktfehler, R6F nicht erweitert.** `production.create` ist für den Bestand
   vollständig (CONFIRMED, Eingänge verbraucht, Ergebnis im Lager mit Kosten). `completeRecord` (COMPLETED, Arbeits-/
   Gemeinkosten als Ausgabe + Kassenzahlung) hatte nie einen Aufrufer (seit dem ersten Commit); die beim Anlegen erfassten
   Arbeits-/Gemeinkosten werden nie gebucht — GuV/Kasse, nicht Bestand. Beim Anschließen: ohne Transaktion, ohne
   Client-Sperre, mit stiller Ersatzfiliale — dieselben Fehler, die R6F aus dem Anlegen entfernt hat.

**Post-Parity-Produktfehler (Backlog, nicht R6F):**
- **PP-1 Lieferantenguthaben-Abstimmung:** nach einer STORNIERTEN Einlösung zeigt die stornierte Zahlung auf die gelöschte
  Guthabenzeile; `counterpartyAudit` meldet `bad_reference` (falsch-positiv, Salden richtig). Heute nicht über Maske oder
  PC2 erreichbar (nur Store-Altwege `cancelReturn`/`deleteReturn` ohne Aufrufer).
- **PP-2 Produktionsabschluss:** `completeRecord` (Arbeits-/Gemeinkosten als Ausgabe + Kassenzahlung) ist in der Oberfläche
  unerreichbar und von `production.create` getrennt; die erfassten Kosten werden nie gebucht.

### Autorität und Atomarität (`CENTRAL_UI_R6F_AUTHORITY_PROVED`)

Vierzehn neue Buchungen, jede durch die C3A-Maschine (Kennung, durabler Nachweis in derselben Transaktion). Rechte wie
die Masken: `orders.cancel`/`mark_line_ordered`/`update_line` hinter `perm.canManageOrders`, die Kommission hinter
`perm.canManageConsignments`, der Rest ohne Tor wie am Primary. Negativ geprüft: fremde Filiale, fremde Belege,
vom Client gesendete Summen/Salden/Bestände/Buchungswerte, gefälschter Urheber, veraltete Fassung, ungültige Artikel-/Los-/
Medienverweise, zu große/ungültige Dokumente, unzulässige Übergänge. Fehlerinjektion an den kritischen Punkten → nichts.

### Beweise

```
Unit    r6f/purchase 203/0 · r6f/order 253/0 · r6f/consignment 427/0 · r6f/production 111/0 · r6f/product-media 46/0 · r6f/office 205/0 · r6f/final-gate 90/0
Nachbarn r6e (alle 7) · r6d (4 + final-gate) · r6c (3) · r6b · r5b/r5c/r5d/r5e/r5f · bridge c3–c6/client-ui/return-chain · uiparity r1/r2c/r2d/r3/r4b/r4c · consignment/payout — 56 Dateien grün
Rust    cargo test --lib bridge 37/0 · media 203/0 · sync_schema 8/0 · manifest-drift 1443/1443 · TS app/node 0 · Lint-Delta 0
Two-App test/e2e/r6f-purchases-orders-office.e2e.mjs 438/0 (4m 54s; PC2 als Benutzer B, Primary als A; nach dem Medien-Fix neu gebaut)
FINAL   r6f/ocr-offline 24/0 · r6f/office 223/0 (inkl. Größenvertrag) · r6f/order-gold-cancel-contract 35/0 · r6f/supplier-credit-reversal-contract 48/0 ·
        r6f/order 253/0 · r6f/final-gate 90/0 · Nachbarn 23 Dateien grün (Gates r6c–r6e, r5e Auftrag, r6d Gold, Sync/Cursor, Push, UI-Matrix) ·
        manifest-drift 1443/1443 · TS app/node 0 · Lint-Delta 0
Two-App FINAL (neu gebaut; voller Lauf, weil der Push-Weg aller Flüsse und der Auftragsstorno geändert wurden) 467/0 (4m 52s):
        OCR echt für PC2 und am Primary, derselbe Text, gespeichert, verlorene Antwort → eingefrorenes Ergebnis; Netz (CDP, Seite +
        Worker): alle fünf OCR-Dateien vom Primary selbst, kein fremder Host; App-Datei +5,8 MiB (51 619 328 → 57 726 464 B, Debug)
```

### Stand der R6A-SSOT nach R6F (`CENTRAL_UI_R6F_SSOT_UPDATED`)

```
A vorher             16
R6F Umfang           16   (Einkauf 3 · Auftrag 5 · Kommission 2 · Produktion 1 · Bildänderung 1 · Aufgaben 2 · Dokumente 2)
geschlossen          16
umklassifiziert       0
verbleibend           0
neue Buchungen       14   (Bildänderung über die vorhandene products.update)
neue Auskünfte        0
Registry            160 → 174   (1 Probe + 71 Auskünfte + 102 Buchungen)
```

Kategorie A ist damit geschlossen. Kategorie B war seit R6B geschlossen; C (Rechnerwerkzeuge), D (unerreichbar) und E
(Löschen, Hauskonfiguration, Buchhaltungswerkzeuge) bleiben bewusst am Primary und sind NICHT als geschlossen gezählt.

## Central UI Parity R4–R6F — CLOSED (14.09.2026)

Stand `ac868a8` (`HEAD == origin/main`), Version **0.8.54**, kein Release, Public Latest `v0.8.54`. Reiner Abschluss-Audit:
statisch gegen den Code und die vorhandenen kleinen Gates, kein Build, kein Zwei-Rechner-Lauf, keine Produktänderung.

**Parität abgeschlossen heißt:** jede Schreibhandlung der gemeinsamen Oberfläche hat auf PC2 entweder den gemeinsamen Weg
über den Primary oder ist bewusst und ehrlich maschinenlokal (C), untätig (D) oder Primary-only (E). Es heißt **nicht**, dass
das Produkt fehlerfrei ist — der Post-Parity-Backlog unten bleibt offen.

### Gesamtzahlen (`CENTRAL_UI_FINAL_COUNTS_PROVED`)

```
R6A recorded baseline (12.09.2026, dokumentiert):
   60 already shared/remote
+ 171 classified rows
= 231 entrypoints

Final audit freshly verified (14.09.2026, Write-Gap-SSOT gegen den Code):
  171 classified rows       A 95 · B 8 · C 15 · D 12 · E 41   (maschinell gezählt)
  A open 0                  95/95 geschlossen (R6C 16 · R6D 41 · R6E 22 · R6F 16)
  B open 0                   8/8  geschlossen (R6B)
  C / D / E                 15 / 12 / 41 — einzeln neu geprüft (Anhang), alle korrekt eingeordnet
```
Die **231 ist die dokumentierte R6A-Baseline, keine aktuelle Codezählung.** Die 60 bereits gemeinsamen Einstiege (R6A:
40er-Matrix + `invoices.cancel` + Schnellanlage Kunde + Navigation) stehen nicht als Tabellenzeilen und wurden im Final
Audit **nicht** einzeln neu gezählt. Frisch geprüft sind die 171 klassifizierten Zeilen und, getrennt, die 40er-Matrix
(§ Matrix).

### Kategorie C — maschinenlokal (`CENTRAL_UI_FINAL_CATEGORY_C_PROVED`)

15/15 bleiben C (43 Einstiege). Keine C-Zeile ist ein täglicher Geschäfts-Write, der über den Primary gehen müsste; kein
C-Weg schreibt auf PC2 in eine lokale Geschäfts-DB (Abmelden: eigener Client-Zweig `auth.ts:207`; Update-Sicherung ohne DB
untätig; Ausgaben-Generator übersprungen; Filialwechsel verborgen; `/settings` = `PrimaryOnlyNotice`). Zu Recht lokal auf
PC2: Spotpreis, Etikettendruck am Arbeitsplatz, Update, Anmelden/Trennen/Abmelden. Zwei Etiketten-Präzisierungen:
„Fällige Ausgaben erzeugen" ist eine Automatik des Primary (auf PC2 still, nichts); der KI-Schlüssel gehört zu Recht dem
Rechner, aber die KI-Knöpfe auf PC2 scheitern erst nach dem Klick → **PP-3**.

### Kategorie D — untätig/unerreichbar (`CENTRAL_UI_FINAL_CATEGORY_D_PROVED`)

12/12 bleiben D; kein versteckter aktiver Pfad, kein sichtbarer Knopf, der Erfolg vortäuscht. InvoiceDetail-Kopf/Status/
Zeilen: `editing` wird nur je auf `false` gesetzt. SyncDuplicateGuard: sein Ereignis kommt nur aus `syncNow`, das im Client
verweigert. Login/Onboarding/FirstRunGate: im Client nie gemountet. Alter ClientShell-Bereich + 11 Client-Formulare:
nur bei defektem Ausweis/Speicher erreichbar — dann funktionieren sie (echte Fernaufträge), sind also nicht irreführend
(Rückbau → **PP-7**).

### Kategorie E — Admin/System/Primary-only (`CENTRAL_UI_FINAL_CATEGORY_E_PROVED`)

41/41 sauber (28 Löschknöpfe + 13 Werkzeug-/Einstellungsgruppen). Kein sichtbarer PC2-Knopf scheitert spät: jeder
Lösch-Öffner ist auf PC2 gesperrt und nennt den Grund; wo ein Bestätigungsdialog folgt, steht der Riegel davor; „Delete (n)"
der Mehrfachauswahl ist nur über das gesperrte „Select" erreichbar, der Handler hat den Riegel. „Auftrag löschen" bleibt E
(Riegel `OrderDetail.tsx:499` vor der Weiche; der Storno ruft `deleteOrder` nicht mehr). Import: Route = Hinweis, Knopf
gesperrt, `ImportPage` stoppt vor Sicherung. Kein lokaler DB-Zugriff auf PC2.

**PP-6 aufgelöst — die Primary-only-Handler ohne eigenen Riegel, einzeln:**

| Handler | Zeile | UI auf PC2 | Handler-Callpath | Bridge/Command | Renderer | lokale DB/Rust auf PC2 | bestehender Guard |
|---|---|---|---|---|---|---|---|
| `SettingsPage`: Firma, Steuer, Kategorien, Filialen, Benutzer, Nummernkreise, Ländervorwahlen, Dubletten; dazu Purge/Reset und die Panels Sicherung, Wartung, Datenort, Scope, Owner, Adopt | E L2308–L2315 | `/settings` → `PrimaryOnlyNotice` (`App.tsx:477`); die Öffner Sidebar `:352`, AIPage `:260`, WatchList `:542` führen nur auf diese Route | Closures in `SettingsPage`; einziger Importeur `App.tsx:57`; die sechs Panels und die Ländervorwahl-Schreiber nur aus `SettingsPage` | keine Mutation dieser Domänen in `command-registry.ts`/`bridge.rs` (174 `OP_*`; einziger Treffer: Auskunft `categories.list`) | nie montiert | `db` auf PC2 nie gesetzt → `getDatabase()` wirft (`database.ts:3439`), `saveDatabase` ohne `db` untätig (`:3326`); kein Tauri-Befehl für diese Schreibvorgänge (`lib.rs`, `generate_handler`) | Routenweiche + DB-los |
| `BackfillPage` (20 Knöpfe) | E L2278 | `/ledger-backfill` → Hinweis (`App.tsx:471`); Sidebar-Link `:78` führt nur dorthin | Closures; einziger Importeur `App.tsx:54`; `core/ledger/backfill.ts` nur aus `BackfillPage` importiert | kein Op | nie montiert | wie oben | Routenweiche + DB-los |
| `LedgerDebugPage` (≈43) | E L2279 | `/ledger-debug` → Hinweis (`App.tsx:489`); kein Link in der App | Closures; einziger Importeur `App.tsx:64` | kein Op | nie montiert | wie oben | Routenweiche + DB-los |
| `RepairFlowTestPage` (2) | E L2316 | `/admin/repair-flow-test` → Hinweis (`App.tsx:423`); kein Link | Closures; einziger Importeur `App.tsx:16`; Rechte-Weiche `:1610` | kein Op | nie montiert | wie oben | Routen- + Rechteweiche + DB-los |
| `RepairReconcilePage` (beim Audit mitgefunden; keine SSOT-Zeile, weil kein Link in der App) | — | `/admin/reconcile` → Hinweis (`App.tsx:429`, seit R2C) | einziger Importeur `App.tsx:17`; Rechte-Weiche `:48` | kein Op | nie montiert | wie oben | Routen- + Rechteweiche + DB-los |
| Orphan-Storno „Storniere alle Orphans" | E L2277 | Seite läuft auf PC2 (Auskunft `page.reconciliation.get`), der Knopf wird nicht gerendert (`ReconciliationPage.tsx:251`, `!readsFromPrimary() &&`) | der Handler ist die Inline-Closure dieses Knopfs, kein anderer Aufrufer | kein Storno-Op (nur die Auskunft) | Closure existiert auf PC2 nicht | `hasReversalFor`/`reverseSource` → `getDatabase()` wirft → `catch` → „Reversed: 0 · failed: n": keine Schreibwirkung, keine Erfolgsmeldung | Renderweiche + DB-los |

Befund: **Kein** Handler ist von PC2 grundsätzlich erreichbar.
- Die Seiten werden auf PC2 nie montiert; die Routenweiche liest dieselbe Wahrheit `isClientMode()`, die auch den DB-Start
  verhindert (`App.tsx:149–161`).
- Es gibt keinen Moduswechsel im laufenden Fenster: `enterClientMode` und `leaveClientMode` laden sofort neu
  (`FirstRunGate.tsx:199`, `ClientShell.tsx:153/431`), und im Primary-Modus ohne DB rendert die App keine Routen
  (`App.tsx:382`).
- Der Orphan-Handler existiert nur als Closure des nicht gerenderten Knopfs.
- Einen Fernweg gibt es nicht; ein unbekannter Name wird dreifach abgewiesen.
- Selbst ein erzwungener Aufruf endet am fehlenden `db`, ohne Schreibwirkung.

**PP-6 ist damit Defense-in-Depth-/Härtungs-Backlog** (je Handler ein eigener `primaryOnlyLocked()`-Riegel), **kein offener
Parity-Gap**; keine Produktänderung, E-Zahl unverändert 41.

### Die ursprüngliche 40er-Matrix (`CENTRAL_UI_FINAL_ORIGINAL_MATRIX_PROVED`)

Frisch aus `test/uiparity/_r4c-write-matrix.ts` gezählt: **40 = 36 verdrahtet · 0 exakt offen · 0 Klasse B · 4 ohne
Handlung**; `invoices.cancel` steht getrennt in `R5F1_NEUE_BUCHUNGEN` (daher meldet das Gate „37 verdrahtet").
`r4c-write-matrix` 456/0, `r3-write-matrix` 15/0.

### Registry 174 (`CENTRAL_UI_FINAL_REGISTRY_174_PROVED`)

`174 = 1 Probe + 71 Reads + 102 Mutationen`; TS (`ALLOWED_MUTATIONS` + angemeldete Auskünfte) == Rust (`bridge.rs`,
174 `OP_*`, `REMOTE_OPS`). Jede der 102 Mutationen hat einen Eintrag in `OPERATION_PERMISSIONS` (Reads prüfen Filiale/
Ausweis). Alle 92 Operationsnamen an Aufrufstellen der Oberfläche sind registriert, keine verwaiste Operation.
Unbekannter Name dreifach abgewiesen: `/api/command` (`routes.rs:211`, `OpNotAllowed`), `submit` (`bridge.rs:884`),
Renderer (`BRIDGE_OP_NOT_REGISTERED`). Gates: r6f final-gate 90/0, c3g 119/0, c4-authorization 169/0, Rust bridge 37/0.

### PC2 ohne Datenbank (`CENTRAL_UI_FINAL_DBLESS_PC2_PROVED`)

PC2 hat keine maßgebliche Geschäfts-DB: Start ohne DB (`CENTRAL_C2_CLIENT_DBLESS_STARTUP_PROVED`), keine Geschäftslesung
aus einer lokalen DB (`CENTRAL_UI_R2C_NO_CLIENT_BUSINESS_DB_READ_PROVED`), Lesen vom Primary (`CENTRAL_C2_READ_AUTHORITY_PROVED`),
Alt-Sync im Client verweigert (`legacySyncRefused`), jede Schreibhandlung = Fernauftrag; eine alte `lataif.db` auf PC2 bleibt
unberührt und irrelevant (jeder Zwei-Rechner-Lauf prüft ihren Hash, zuletzt R6F 467/0). PC2 öffnet keine SQLite-Datei —
weder lokal noch über SMB —, es spricht nur HTTP mit dem Primary. Der Primary ist einziger Schreiber; Fernaufträge sind
durabel und idempotent (`CENTRAL_C3_DURABLE_IDEMPOTENCY_SCHEMA_PROVED`, `CENTRAL_C3_ATOMIC_COMMAND_TRANSACTION_PROVED`).
Gates: client-read-mode 109/0, r2c-direct-db-scan 14/0, write-foundation 196/0, c6 38/0, r6b 95/0.

### Urheber, Protokoll, Fassung (`CENTRAL_UI_FINAL_AUDIT_INTEGRITY_PROVED`)

Fern = der geprüfte PC2-Absender aus dem Ausweis (`withActingUser`, R6E), lokal = die Primary-Anmeldung
(`CENTRAL_UI_R6E_LOCAL_ACTOR_PROVED`); der Client kann `created_by`/Urheber nicht setzen (jede Hausfolge weist Urheber-
Felder ab: „the primary decides …"). Bearbeitbare gemeinsame Domänen tragen `revision` + Trigger, veraltete Fassung →
`RECORD_CHANGED`. Verlorene Antwort → dieselbe `commandId` → eingefrorenes Ergebnis, genau eine Wirkung
(`CENTRAL_UI_R6F_IDEMPOTENCY_PINNED`, Zwei-Rechner-Läufe R5B–R6F). Gates: r6e actor-attribution 37/0, r6f final-gate 90/0.

### Post-Parity-Backlog (`CENTRAL_UI_POST_PARITY_BACKLOG_PINNED`)

Keiner ist eine A/B-Lücke: entweder kein fehlender Fernweg für eine Geschäftsbuchung, oder über Maske/PC2 nicht erreichbar.

| ID | Beschreibung | Domäne | Schwere | warum kein A/B | spätere Behandlung |
|---|---|---|---|---|---|
| PP-1 | Nach einer STORNIERTEN Guthaben-Einlösung zeigt die stornierte Zahlung auf die gelöschte Lieferanten-Guthabenzeile; die Abstimmung meldet `bad_reference` (falsch-positiv, Salden richtig) | Einkauf/Lieferanten | niedrig | nur über Store-Altwege `cancelReturn`/`deleteReturn` ohne Aufrufer erreichbar | `counterpartyAudit` ignoriert stornierte Guthaben-Zahlungen, oder Zeile erhalten (dann Klasse A des Guthabens) |
| PP-2 | `completeRecord` (Arbeits-/Gemeinkosten als Ausgabe + Kassenzahlung, COMPLETED) hat nie einen Aufrufer; erfasste Kosten werden nie gebucht | Produktion/GuV | mittel | eigener, nie verdrahteter Primary-Workflow; `production.create` ist für den Bestand vollständig | als Hausfolge (Transaktion, Client-Sperre, Filiale) anschließen, dann Fernbefehl |
| PP-3 | KI-Identifizieren (`NewProductModal`, `WatchList`, `ProductDetail`), KI-Nachrichtentext und `/ai` sind auf PC2 sichtbar, melden aber erst nach dem Klick „Set OpenAI API key in Settings" — Settings ist auf PC2 gesperrt | KI/Artikel | mittel | keine Geschäftsbuchung fehlt (KI schlägt nur vor, gespeichert wird über `products.update`); Schlüssel ist maschinenlokal (C) | Primary-seitige KI (`/api/ai/identify`) auch für PC2 nutzen, oder auf PC2 sperren/erklären |
| PP-4 | Fällige wiederkehrende Ausgaben entstehen nur beim Primary-Start/Filialwechsel und beim Öffnen der Ausgabenliste am Primary; läuft er über den Monatswechsel, erscheinen sie verspätet | Finanzen/Ausgaben | niedrig–mittel | Automatik des Primary, kein PC2-Einstieg | Auslöser bei Tageswechsel am Primary |
| PP-5 | „Trennen" löscht `lataif_session` nicht (`client-mode.ts:50`), `clearClientSession` wird nie gerufen; ein späterer Start im Primary-Modus übernimmt die alte Sitzung ungeprüft | Anmeldung | niedrig | maschinenlokale Sitzung, keine Geschäftsbuchung | beim Trennen Sitzung leeren, beim Start prüfen |
| PP-6 | Defense-in-Depth: `SettingsPage`, `BackfillPage`, `LedgerDebugPage`, `RepairFlowTestPage`, `RepairReconcilePage` und der Orphan-Storno haben keinen eigenen Handler-Riegel; geschützt durch Routen-/Renderweiche, fehlenden Fernweg und DB-losen PC2 (einzeln belegt, § Kategorie E) | System/Wartung | niedrig (Härtung) | strukturell von PC2 unerreichbar — kein Fernweg, keine lokale DB; kein Parity-Gap | `primaryOnlyLocked()` am Handleranfang + statischer Pin |
| PP-7 | Toter/alter Code: InvoiceDetail-`editing`-Zweig mit lokalen `updateInvoice`; alter ClientShell-Bereich (11 Testdateien nutzen noch seine Selektoren); `resetPrimarySource` beim Abmelden nie gerufen | Aufräumen | niedrig | unerreichbar (D) | entfernen, Tests umstellen |
| PP-8 | Der Auftragsstorno löscht die aus einer Überzahlung gewährte Kundengutschrift (`orderStore.ts:1237` → `teardownOrderOverpayCredit` → `clawbackGrantedCredit('order_overpayment')`, `orderPaymentStore.ts:39–44`) | Aufträge/Kundenguthaben | mittel | `orders.cancel` ist registriert und angeschlossen; beide Rechner laufen dieselbe Hausfolge am Primary — Fachregel, kein fehlender Fernweg | fachlich entscheiden (Guthaben stehen lassen oder erstatten), eigene Scheibe |
| PP-9 | `deleteOrder` storniert jede offene Gold-Verbindlichkeit des Auftrags, auch geliefertes/teilweise beglichenes Gold (`orderStore.ts:1460–1468`); der Storno schont diese seit R6F (`goldPayableSurvivesCancel`) | Aufträge/Gold | niedrig | „Auftrag löschen" ist E (Primary-only, auf PC2 gesperrt, L2203); kein Fernweg vorgesehen | dieselbe Regel wie beim Storno, oder Löschen bei bewegtem Gold sperren |
| PP-10 | `production_inputs`/`production_outputs` fehlen in `KNOWN_BUSINESS_TABLES` (`sync_policy.rs:172`, nur `production_records` :202) und in der Modulzuordnung `track.ts:45`, obwohl der Renderer sie neu lädt (`sync-service.ts:493`) | Produktion/Tabellen-Abgleich | niedrig | betrifft nur den Tabellen-Abgleich zwischen Datenbank-Rechnern; PC2 hat keine DB und schreibt über `production.create` am Primary | Tabellen aufnehmen + Policy-Test |
| PP-11 | Die Aufgabenmaske zeigt „NOTES" (`TaskList.tsx:325–330`), `tasks` hat keine Spalte, der Wert wird verworfen (`taskStore.ts:100`) | Aufgaben | niedrig | `tasks.create`/`tasks.update` sind registriert; auf beiden Rechnern gleich verworfen — Schemafrage, kein Fernweg fehlt | Spalte + Migration, oder Feld entfernen |
| PP-12 | Große Dokumente (bis 25 116 672 B) können die Standardfrist des Brücken-Rundlaufs reißen (`bridge.rs:474`, `DEFAULT_TIMEOUT` 20 s); Wiederholung mit derselben `commandId` ergibt genau eine Wirkung | Dokumente/Brücke | niedrig | `documents.upload` ist registriert und angeschlossen; es fehlt kein Weg, nur eine längere Frist | größenabhängige Frist für Dokument-Ops |
| PP-13 | Eigene Reparatur (OWN) mit Werkstatt: die Werkstattkosten wirken ZWEIMAL auf den Gewinn — Ausgabe `RepairCosts` (Soll EXPENSES_OPERATING) bei „in Arbeit" UND Kapitalisierung in Los/`purchase_price` bei „ready" (→ COGS beim Verkauf). Verkauf 300, Werkstatt 100: Gewinn 100 statt 200, im Hauptbuch wie in den Berichten, bezahlt wie unbezahlt (§ „PP-13" am Ende) | Reparaturen/GuV | mittel–hoch | kein Fernweg fehlt; Primary und PC2 laufen dieselbe `updateStatus`-Folge am Primary — Fachregel | Werkstattschuld einer OWN-Reparatur kapitalisiert buchen (Soll INVENTORY / Haben A/P), nicht als Betriebsausgabe; Zeilenstorno nimmt die Kapitalisierung zurück |
| PP-14 | Kundenreparatur mit Werkstatt, Rechnungsweg: die Werkstattkosten wirken DREIMAL — `internalCost` spiegelt den Voranschlag (`internalCostOnCreate`), die Werkstattzeile trägt ihn ebenfalls, beide gehen in den Rechnungseinstand (`repairInvoiceLineCost` = internal + Zeilen → COGS 200), dazu die Betriebsausgabe `RepairCosts` 100. Rechnung 300, Werkstatt 100: Gewinn 0 statt 200; INVENTORY −200 für eine Dienstleistung ohne Bestand (§ „PP-13 — Behebung") | Reparaturen/GuV | hoch | kein Fernweg fehlt; eigener Vertrag: Dienstleistung ohne Bestand, zwei Erlöswege (Rechnung mit COGS, Direktzahlung `REPAIR_PAYMENT` ohne COGS) | Rechnungseinstand ohne Spiegel (bei „external" nur die Zeilen) und Werkstattschuld je Erlösweg genau einmal — eigene Entscheidung |

**Stand nach Post-Parity R7A (14.09.2026):** PP-1, PP-2, PP-8, PP-9, PP-10, PP-11 **geschlossen** (bewiesen, § „Post-Parity R7A —
Business Correctness" am Ende dieses Dokuments); **offen** bleiben PP-3, PP-4, PP-5, PP-6, PP-7, PP-12. Registry seit R7A 175.
**Neu nach R7A (14.09.2026):** PP-13 und PP-14 bestätigt und **geschlossen** (§ „PP-13 + PP-14 — Repair-Accounting-Abschluss" am
Ende). Offen bleiben PP-3, PP-4, PP-5, PP-6, PP-7, PP-12.
**Neu nach R7B (14.09.2026):** PP-3, PP-4, PP-5, PP-6 und PP-7 **geschlossen**; PP-12 **teilweise** (Fristen je Dokumentweg und
Anzeige gebaut, die Upload-Frist berücksichtigt aber die mit der Datenbankgröße wachsende durable Speicherung nicht — § „Post-Parity
R7B — Plattform / Laufzeit / Härtung", Review-Nachweis). Registry unverändert 175.
**Neu nach R7B / PP-12-Abschluss (15.09.2026):** PP-12 **geschlossen** — die schreibenden Dokumentwege rechnen die Datenbankgröße
am Primary in ihre Frist ein, belegt bis 451/518 MB; dazu die Bild-Uploads bestandsaufgenommen und die Belegbilder auf den EINEN
Normalisierer geführt (§ „R7B / PP-12 — Bildwege und Frist nach der echten Speicherung" am Ende; Review
`docs/r7b-pp12-image-paths-review.md`). Registry unverändert 175.
**Neu nach der PP-12-Abschlussprüfung (15.09.2026, Nachtrag):** PP-12 bleibt geschlossen; das reguläre Beenden bei großer
Datenbank ist behoben (Ursache: feste 8-s-Frist auf den Selbst-Abgleich, vorbestehend), Handy-Reparatur-/Inbox-Fotos erfüllen
den Bildvertrag bei der Übernahme, der „New Item"-Artikel trägt seine Fotos im Medienspeicher; jeder weitere Befund mit eigenem
Status (§ „R7B / PP-12 — Abschlussprüfung" am Ende). Registry unverändert 175.

Veraltete Stellen der SSOT (nur Hinweis, Inhalt gilt): Zeilenverweise der Tabelle sind teils verschoben (z. B. InvoiceDetail,
WatchList, ExpenseList); der R6A-Abschnitt „Keine toten Knöpfe" beschreibt den Stand VOR R6B — heute: Abmelden geht auf PC2
(`auth.ts:207`), Löschknöpfe gesperrt mit Grund, `/import` gesperrt, Inventur und Nachrichtenprotokoll über den Primary,
Lieferantenguthaben erstatten/anwenden angeschlossen (R6D); der R6B-Test zählt heute 95/0 statt 97/0.

### Finaler Status

```
Category A = 0
Category B = 0
Category C = bewusst Primary-/maschinenlokal (15)
Category D = bewusst untätig/unerreichbar (12)
Category E = bewusst Admin/System/Primary-only (41)
Registry   = 174 (1 + 71 + 102)
PC2        = ohne Geschäftsdatenbank
Primary    = Autorität, einziger Schreiber
Version 0.8.54 · kein Release · Post-Parity-Backlog PP-1…PP-12 offen
```

### Anhang — Einzelprüfung C, D, E (14.09.2026, statisch gegen `ac868a8`)


#### Kategorie C

##### Audit Kategorie C (maschinenlokal) — Write-Gap-SSOT, Stand HEAD ac868a8

Nur gelesen, statisch. Keine Datei im Repo geändert, kein Build, kein Test.
Grundlage: `docs/central-ui-parity.md` §„Write-Gap-SSOT“ (Z. 2124 ff.), 15 C-Zeilen (Z. 2164, 2171, 2265, 2296–2307), gegen den aktuellen Code geprüft.

Client-Weiche: `isClientMode()` (`src/core/bridge/client-mode.ts:36`) = `readsFromPrimary()` (`src/core/data/primary-source.ts:21`). Im Client wird `initDatabase()` nie gerufen (`App.tsx:149–161`), also wirft `getDatabase()` (`src/core/db/database.ts:3438`). Die ganze Route `/settings` ist im Client eine `PrimaryOnlyNotice` (`App.tsx:477–482`). Deshalb erreicht PC2 keinen Einstieg in SettingsPage/BackupRestorePanel/StorageMaintenancePanel/DataLocationPanel (die drei Panels hängen nur an `SettingsPage.tsx:3144/3146/3148`).

##### Tabelle

| SSOT-Zeile | UI-Einstieg | Laufweg Primary | Warum lokal | PC2 fachlich nötig? | PC2 heute | Klassifikation |
|---|---|---|---|---|---|---|
| L2164 Spotpreis aktualisieren | `pages/dashboard/Dashboard.tsx:612` (`refreshSpot(true)`; Auto-Intervall :86–87) | `getSpotPrices` (`core/market/spot-prices.ts:65`) → `fetch api.gold-api.com` (:45) → Cache in localStorage (:31/:40) | Marktdaten-Anzeige plus Browser-Cache. Keine Geschäftsbuchung, kein DB-Zugriff | Ja, als Anzeige. Der Schreibanteil ist nur der eigene Cache | **Läuft lokal auf PC2, wie es soll** (kein `getDatabase`) | **C korrekt** (eigentlich gar kein Business-Write) |
| L2171 Etiketten drucken | `pages/watches/WatchList.tsx:1276` (Print-Knopf im Modal; öffnen :508/:527. SSOT-Ref 1266 verschoben) | `buildBatchTagsZpl` (`core/print/zpl-tag.ts:286`, rein, nur Typ-Import) → `printRawZpl` (`core/print/raw-print.ts:42`) → Tauri `print_raw_zpl` (`src-tauri/src/lib.rs:1409`) → Windows-Raw-Spooler. Druckername in localStorage (`raw-print.ts:26/33`) | Zebra-Drucker am Arbeitsplatz, lokaler OS-Spooler | **Ja, täglich**. Deshalb gehört er genau auf den eigenen Rechner | **Läuft lokal auf PC2, wie es soll.** Artikel/Kategorien kommen aus der Primary-Hydrierung, kein DB-Zugriff, kein Status-Write. Druckerfehler erscheinen ehrlich im Modal (:1288–1289) | **C korrekt** |
| L2265 Fällige Ausgaben erzeugen (beim Öffnen) | `pages/expenses/ExpenseList.tsx:136` (useEffect. SSOT-Ref :123 verschoben) und zusätzlich `App.tsx:352–358` (Start/Filialwechsel) | `runDueGeneratorOnPrimary` (`core/payables/payables-save.ts:212`) → `recurringExpenseStore.runDueGenerator` (`stores/recurringExpenseStore.ts:137`) → INSERT Ausgaben in die Primary-DB → `saveDatabaseDurably` | **Nicht maschinenlokal im eigentlichen Sinn.** Es ist eine Primary-eigene Automatik, die Geschäftsbuchungen erzeugt | Nein. PC2 soll sie nicht auslösen, der Primary führt seine Monate selbst | **Still, nichts** (`ExpenseList.tsx:136` `!readsFromPrimary()`; `App.tsx:353` `!dbReady` bleibt im Client false). Kein Schein-Erfolg, kein lokaler Write | Kein A/B, Ergebnis stimmt. **Etikett ungenau** („Primary-Automatik“ statt „maschinenlokal“). Nebenbefund: Der Primary startet den Generator nur beim Start/Filialwechsel und beim Öffnen der Ausgabenliste AM PRIMARY. Es gibt keinen Timer, und das Fern-Lesen `store.recurring_expenses.get` (`core/bridge/store-read-commands.ts:246`) löst ihn nicht aus. Bleibt der Primary über einen Monatswechsel an und arbeiten die Nutzer nur an PC2, erscheinen fällige Ausgaben verspätet |
| L2296 Abmelden | `components/layout/Sidebar.tsx:372` | `authStore.logout` (`stores/authStore.ts:115`) → `authService.logout` (`core/auth/auth.ts:202`). Primary: DELETE `sessions` + `saveDatabase` (:213–219). Client-Zweig :207–211: Sitzung weg, `lataif_session` weg, `setClientToken(null)` | Sitzung und Ausweis dieses Fensters. Der Primary prüft jede Anfrage selbst | Ja (Sitzungsende). Lokal ist hier richtig | **Geht**: zurück zu ClientShell-SignIn (`App.tsx:367`; `ClientShell.tsx:74` `signedIn=Boolean(token)` → false). Kein DB-Write. Kosmetisch: `resetPrimarySource` (`primary-source.ts:144`, laut Kommentar „für den Abmeldeweg“) hat keinen Aufrufer, Store-Inhalte bleiben bis zur nächsten Hydrierung im Speicher | **C korrekt** |
| L2297 Filiale wechseln | `Sidebar.tsx:221` (Dropdown nur bei `branches.length > 1`, :202/:210) | `authStore.switchBranch` (:124) → `authService.switchBranch` (`auth.ts:151`) → `getUserBranches` + SELECT `branches` (getDatabase) → `lataif_session` | Sitzungs-/Anzeigekontext der UI, keine Geschäftsbuchung | Bei einer Filiale nein. Bei Mehrfilialbetrieb bräuchte PC2 einen neuen Token vom Primary (Server-Auth); das wäre dann gerade nicht lokal | **Verborgen**: `branchesFor` (`authStore.ts:70–80`) fängt den `getDatabase`-Wurf ab und liefert genau die Token-Filiale, also kein Dropdown. Kein Write | **C vertretbar/korrekt** (heute einfilialig). Hinweis für später: Mehrfilialbetrieb auf PC2 wäre Token-Neuausstellung am Primary |
| L2298 Update installieren | `components/shared/UpdateBanner.tsx:193` | `installUpdate` (:128) → `installOnce` (:65) → `prepareAndInstallUpdate` (`core/updater/update-orchestration.ts:50`): `saveDatabaseDurably` (`database.ts:3354–3355` `if (!db) return;` → No-op) → `downloadAndInstall` → `coordinatedRelaunch` (`core/lifecycle/relaunch-coordinator.ts:111`): `pauseAutoSync`/`waitForSyncIdle` (`sync-service.ts:599/608`), `stop_server_and_confirm_free` (`lib.rs:1566`; `server.stop` → „not running“, `src-tauri/src/sync/mod.rs:418`) → relaunch | Programmdatei dieses Rechners | **Ja**, PC2 muss seine eigene App aktualisieren | **Geht** (statisch gelesen). Banner ist auch im Client gemountet (`App.tsx:405`), Auto-Check nach 5 s (`UpdateBanner.tsx:146`). Flush ohne DB ist wirkungslos, aber harmlos. Kein DB-Write | **C korrekt** |
| L2299 Anmelden | `components/startup/ClientShell.tsx:421–429` (SignIn) | `clientLogin` (`core/bridge/remote-read.ts:95`) → POST `{server}/api/auth/login` **am Primary** → `setClientToken` (localStorage) → `App.tsx:368–373` `installClientSession` (`core/auth/client-session.ts:86`) + `initialize` + `refreshClientSessionContext` | Verbindungs- und Sitzungszustand dieses Rechners. Das Passwort prüft der Primary | Ja | **Geht**, Fehler ehrlich („Server unavailable“ / „Wrong e-mail or password“, :427) | **C korrekt** |
| L2300 Trennen | `ClientShell.tsx:153` (Alt-Bereich, Kat. D) und `:431` (SignIn) | `leaveClientMode` (`client-mode.ts:50–56`: entfernt mode/server/token) → `window.location.reload` → Primary-Boot (`App.tsx:162` FirstRunGate bzw. `initDatabase`) | Modus-Weiche dieses Rechners | Selten (Serverwechsel, Rückbau). Lokal richtig | **Geht.** Im normalen Programm nur über Abmelden → SignIn → Disconnect erreichbar (Settings = NOTICE). Kein Write im Client-Modus. Nebenbefund: `leaveClientMode` löscht `lataif_session` NICHT, und `clearClientSession` (`client-session.ts:131`) hat keinen Aufrufer. Liegt beim Trennen noch eine Client-Sitzung (nur ohne vorheriges Abmelden, z. B. über :153), übernimmt der folgende Primary-Boot sie ungeprüft (`auth.ts:47–58`, `App.tsx:184` `initialize`) | **C korrekt** |
| L2301 Sprache, KI-Schlüssel/-Test (4) | `pages/settings/SettingsPage.tsx:1468/1478` (Sprache), `:1792` (Test), `:1795` (Speichern) | Sprache: `i18n.setLanguage` (`core/i18n/i18n.ts:17`) → localStorage + `dir`/`lang`. KI: `setApiKey` (`core/ai/ai-service.ts:83`) → localStorage `lataif_openai_key` + Schlüsseldatei im Datenort (`writeKeyToTauri` :57), `setModel` (:109). Test: `fetch api.openai.com/v1/models` (:1724) | Geräteeinstellung bzw. Geheimnis dieses Rechners | **KI-Schlüssel: JA.** KI-Identifizieren (`components/products/NewProductModal.tsx:353`, `WatchList.tsx:973`, `ProductDetail.tsx:571/687`), Nachrichtentext (`components/ai/MessagePreviewModal.tsx:110`) und `/ai` (`pages/ai/AIPage.tsx:210/254/337`) rufen OpenAI vom eigenen Rechner mit dem EIGENEN Schlüssel (`ai-service.ts:119–121`). Es gibt keinen Primary-Weg. OCR ist nicht betroffen (läuft am Primary, `stores/documentStore.ts:190`). Sprache: kaum (setzt nur `dir`/`lang`, i18n praktisch nicht verdrahtet) | **NOTICE** (ganze Route, `App.tsx:477–482`). Folge: KI-Knöpfe sind auf PC2 sichtbar und melden erst nach dem Klick „Set OpenAI API key in Settings > AI“. Settings sagt dort „only on main computer“, also **Sackgasse / fails late** | C für den Schlüssel inhaltlich korrekt (maschinenlokal), kein A/B. **Der PC2-Zustand „NOTICE“ ist hier falsch**: PC2 muss den Schlüssel selbst setzen können, oder KI läuft über den Primary |
| L2302 Sync, Server, Owner, Adopt, Scope (14) | `SettingsPage.tsx:2089` (Owner setzen), `:2095` (ändern), `:2102` (Mobile-Scope → `RuntimeScopeDialog` :2215), `:2115` (Adopt → `PrimaryAdoptDialog` :2232), `:2126` (Start/Stop), `:2129` (Discover), `:2139` (Use), `:2167` (Sync Now), `:2168` (Disconnect), `:2198` (Connect), `OwnerProvisionDialog` :2225 | Tauri `sync_server_start`/`sync_server_stop` (`lib.rs:268/281`, Owner-Prüfung gegen Konfig-DB), Alt-Sync `sync-service` | LAN-Server, Primary-Rolle und Konfig-DB DIESES Rechners | Nein. PC2 verbindet sich über ClientShell, der Alt-Sync ist im Client ohnehin verweigert (`sync-service.ts:629` `legacySyncRefused`) | **NOTICE** | **C korrekt** |
| L2303 Update prüfen | `SettingsPage.tsx:3455` | `manualCheck` (:3420) → Ereignis `lataif:check-update` (:3423) + `plugin-updater.check` | Programmdatei dieses Rechners | Nicht zwingend: UpdateBanner prüft auch auf PC2 beim Start automatisch (`UpdateBanner.tsx:146`) | **NOTICE**, kein manueller Check auf PC2 (geringes Manko) | **C korrekt** |
| L2304 Purge / Werksreset (2) | `SettingsPage.tsx:3230` (`handlePurge` :3087), `:3277` (`handleReset` :3058) | `runSafePurge` mit `getDatabase()` + `createPreDestructiveBackup` / `runGuardedReset` (+ `isFactoryResetBlocked`) | Löscht bzw. sichert die DB DIESES Rechners | Nein (keine DB; Löschen ist ohnehin Primary-only, §5) | **NOTICE** | **C korrekt** (steht fachlich nahe an E, auf PC2 bleibt es beides Mal gesperrt) |
| L2305 Sicherung/Wiederherstellung (8) | `pages/settings/BackupRestorePanel.tsx:216` (Backup), `:219` (Laden), `:245` (Restore wählen), `:268/269/270` (Ort ändern/zurücksetzen/öffnen), `:297/301` (Aufbewahrung), `:315` (Scan), `:329/342` (GC), `:359` (Backup bestätigen), `:376` (Restore bestätigen) | Tauri (Backup-Intent, koordinierter Relaunch, Medien-GC, OS-Ordnerdialog) | DB, Medien und Ordner DIESES Rechners | Nein (keine DB) | **NOTICE** (Panel nur in `SettingsPage.tsx:3144`) | **C korrekt** (tatsächlich eher 12+ Klickziele statt 8) |
| L2306 Speicherwartung (3) | `pages/settings/StorageMaintenancePanel.tsx:114` (Dry-Run), `:116/:141` (Anwenden), `:183/:195` (Verdichten) | Tauri + Owner-Passwort | Medien- und DB-Datei DIESES Rechners | Nein | **NOTICE** (`SettingsPage.tsx:3146`) | **C korrekt** |
| L2307 Datenort (3) | `pages/settings/DataLocationPanel.tsx:125` (wählen, OS-Dialog), `:128` (Preflight), `:149` (bestätigen) | Tauri Datenort-Umzug | Dateisystem DIESES Rechners | Nein (der Client hat keinen Datenort, `client-mode.ts:3–5`) | **NOTICE** (`SettingsPage.tsx:3148`) | **C korrekt** |

##### Ergebnis

- **Geprüft:** 15/15 C-Zeilen (43 Einstiege laut SSOT-Zählung).
- **Kategorie C weiter richtig:** 15/15. Keine C-Zeile ist in Wahrheit ein normaler Geschäfts-Write, der über den Primary gehen müsste (A/B). Zwei Einschränkungen:
  - L2265 ist inhaltlich eine Primary-Automatik, nicht maschinenlokal. Das Etikett ist ungenau, das Verhalten stimmt.
  - L2301: Der KI-Schlüssel ist zu Recht lokal, aber sein PC2-Zustand (NOTICE) passt nicht zum Bedarf.
- **(c) C-Weg, der auf PC2 in eine lokale Geschäfts-DB schreibt:** keiner. Logout geht im Client über den eigenen Zweig; der Update-Flush ist ein No-op ohne `db`; der Generator wird übersprungen; der Filialwechsel ist verborgen; Settings ist NOTICE.

##### Befunde (ohne ID)

1. **Mittel — KI auf PC2 in der Sackgasse (Post-Parity-UI-Defekt, fails late).** Den Schlüssel gibt es nur pro Rechner (`ai-service.ts:66–89`). Auf PC2 lässt er sich nicht setzen, weil `/settings` dort eine `PrimaryOnlyNotice` ist (`App.tsx:477–482`). Die KI-Knöpfe bleiben sichtbar (`NewProductModal.tsx:353`, `WatchList.tsx:973`, `ProductDetail.tsx:571/687`, `MessagePreviewModal.tsx:110`, `AIPage.tsx:254/337`), melden erst nach dem Klick „Set OpenAI API key in Settings > AI“ und verweisen damit auf die gesperrte Seite.
2. **Niedrig–mittel — Generator für fällige Ausgaben ohne Takt am Primary.** Er läuft nur beim Primary-Start/Filialwechsel (`App.tsx:352–358`) und beim Öffnen der Ausgabenliste am Primary (`ExpenseList.tsx:136`). PC2-Nutzung und das Fern-Lesen (`store-read-commands.ts:246`) lösen ihn nie aus.
3. **Niedrig — Trennen lässt `lataif_session` stehen.** `leaveClientMode` (`client-mode.ts:50–56`) räumt die Sitzung nicht, `clearClientSession` (`client-session.ts:131`) hat keinen Aufrufer. Der folgende Primary-Boot übernimmt eine liegengebliebene Sitzung ungeprüft (`auth.ts:47–58`, `App.tsx:184`). Das tritt nur auf, wenn ohne vorheriges Abmelden getrennt wird.
4. **Kosmetisch.** `resetPrimarySource` hat beim Abmelden keinen Aufrufer. Sprache ist auf PC2 nicht umstellbar (kaum Wirkung). SSOT-Zeilenrefs verschoben: WatchList 1266→1276, ExpenseList 123→136.

#### Kategorie D

##### Final-Audit Kategorie D (untätig / unerreichbar) — Stand HEAD ac868a8

Statisch, nur gelesen. Grundlage: `docs/central-ui-parity.md` §Write-Gap-SSOT (Zeilen 2134–2136, 2194–2196, 2317–2322) gegen den aktuellen Code.

**Ergebnis:** 12 von 12 D-Zeilen geprüft. Alle 12 sind weiterhin richtig als D eingestuft. Keine ist falsch klassifiziert. Keine D-Zeile hat einen sichtbaren Knopf, der auf dem Primary oder auf PC2 funktionsfähig aussieht, aber nichts tut. Keine meldet einen Schein-Erfolg.

##### Tabelle

| SSOT-Zeile | UI-Einstieg (heute) | Warum untätig/unerreichbar (Beweis) | versteckter Pfad? | sichtbar & irreführend? | Klassifikation |
|---|---|---|---|---|---|
| L2134 Kopf speichern | `src/pages/invoices/InvoiceDetail.tsx:705` „Save“ → `handleSaveEdit` :266–275 → `updateInvoice` (lokal, ohne `w.ok`) | `editing` = `useState(false)` :82. Es gibt nur zwei Setter, beide mit `false`: :274 und :704 (Cancel). Kein `setEditing(true)`, auch nicht über `searchParams`; gelesen wird nur `print` :165. Der Knopf steht im Zweig `editing ? … : …` :702. Er wird auf dem Primary UND auf PC2 nie gerendert. | Nein. `handleSaveEdit` wird nur an :705 benutzt. Im Normalfall ist „Edit“ :709 → `/invoices/:id/edit` (InvoiceCreate, siehe L2133). | Nein, unsichtbar. Latentes Risiko: Wird der Zweig reaktiviert, schreibt er auf PC2 lokal ohne Fernweg. Das ist Code-Hygiene, kein UI-Defekt. | **D korrekt** (auf beiden Rechnern tot). Die Zeilennummer im SSOT ist veraltet (649 → 705). |
| L2135 Status-Override | `InvoiceDetail.tsx:783–820` Status-Knöpfe, onClick :787 → `updateInvoice(id,{status})` :811 | Liegt in `{editing && (<Card>…)}` :758–833. `editing` wird nie `true` (Beweis siehe L2134). Das Banner :748 und die Inline-Felder für Fälligkeit/Notizen :1186–1216 hängen am selben toten Flag. | Nein. Kein zweiter Aufrufer von `updateInvoice({status})` in dieser Datei. | Nein, unsichtbar | **D korrekt**. Die Zeilennummer im SSOT ist veraltet (766 → 787/811). |
| L2136 Zeilen bearbeiten (Detail) | `InvoiceDetail.tsx:829` „Edit Lines“ → `openLinesEdit` :277–293 → Modal :1417 → „Save Lines“ :1545 → `saveLines` :347 → `w.ok('invoices.update')` :371 | Der Knopf :829 liegt in der toten `editing`-Card. `openLinesEdit` wird nur an :829 benutzt. `setLinesModal(true)` gibt es nur in `openLinesEdit` :292. Das Modal ist deshalb nie offen. | Nein. „Manage Payments“ :830 in derselben Card ist ebenfalls tot. Das Zahlungs-Modal hat aber einen zweiten, aktiven Öffner :1030 (keine D-Zeile). | Nein, unsichtbar. `saveLines` wäre fernfähig (`invoices.update` mit `expectedRevision`). | **D korrekt**. Die Zeilennummer im SSOT ist veraltet (784→1499 → 829→1417/1545). |
| L2194 Dubletten-Guard bestätigen | `src/components/sync/SyncDuplicateGuard.tsx:601` → `confirmMerge` :377–396 → `mergeIntoExisting` :381 + `updateProduct` :385 | Das Modal rendert nur bei nicht-leerer `queue`. `setQueue` wird nur im Handler :335 aufgerufen, der auf `lataif:sync-products-inserted` hört (:350). Einziger Sender ist `src/core/sync/sync-service.ts:508` in `pullChanges` :255. Deren einziger Aufrufer ist `syncNow` :540, das im Client-Modus bei :525 abbricht (`legacySyncRefused`, :41–48 `isClientMode()`). `startAutoSync` :573 und `connectToServer` :629 werden ebenfalls verweigert. | Auf PC2: nein (einziger Sender, grep geprüft). Auf dem Primary ist der Guard aktiv (gemountet in App.tsx:406). Das liegt außerhalb des PC2-Scopes. | Nein. Auf PC2 erscheint nie ein Modal. | **D korrekt** (PC2 UNERR) |
| L2195 Dubletten-Guard übernehmen/ablehnen | `SyncDuplicateGuard.tsx:586`/`:598` „Ablehnen“ → `keepAsNew` :365 → `runAutoIdentify` :52–144 (`allocateSkuOnCreate` :108, `updateProduct` :144). `:589` „Daten übernehmen“ → `copyDetailsFromExisting` :404–456 (`allocateSkuOnCreate` :428, `updateProduct` :430/:444) | Dasselbe Modal wie L2194, dieselbe Beweiskette. Modal-`onClose` = `keepAsNew` :480. | Nein. `runAutoIdentify` ist nicht exportiert; die Aufrufer sind nur :347 und :372 (grep). „Bestehenden öffnen“ :585/:597 navigiert nur. | Nein | **D korrekt** |
| L2196 Dubletten-Guard Hintergrund | `SyncDuplicateGuard.tsx:247–252`: roher `UPDATE products SET image_description…` + `saveDatabase` + `trackUpdate` | Liegt nur in Schritt 1 des Event-Handlers (:238–258). Das Ereignis wird auf PC2 nie gesendet (siehe L2194). Kein UI-Element. | Nein | Nein (keine Oberfläche) | **D korrekt** |
| L2317 Alt-Bereich des Client-Fensters | `src/components/startup/ClientShell.tsx:131–313` (Bereichs-Chips :134–143, Refresh :148, Disconnect :153, Formulare :158–248, Edit-/Open-Knöpfe :273–312) | Bedingung: `App.tsx:365–375` (clientMode, clientReady, `!session`) UND ClientShell `signedIn=true` (:74 aus gespeichertem Token oder :128 nach SignIn). Die Session entsteht aus dem Token (`App.tsx:154`/`:370` → `installClientSession` → `sessionFromToken`, `src/core/auth/client-session.ts:65–91`). Sie fehlt nur, wenn im Token `sub`, `branch_id` oder `role` fehlen oder `localStorage.setItem` wirft (:89). Der Primary stellt alle drei Claims aus: `src-tauri/src/sync/routes.rs:303–336` (`ub.role` aus `user_branches`), `src-tauri/src/sync/auth.rs:21–27`. Logout im Client leert das Token (`src/core/auth/auth.ts:207–211`) und führt zu SignIn, nicht in den Alt-Bereich. Ein 401 leert das Token (`remote-read.ts:75`) und setzt `setSignedIn(false)` (ClientShell :110). | Ja, nur der im SSOT genannte Randfall (defektes Token ohne Rolle oder Speicherfehler). Dann ist der Bereich **funktionsfähig, nicht untätig**: Die Formulare senden über `CommandSaveController` an registrierte Ops (`command-registry.ts:87–100` `ALLOWED_MUTATIONS`). | Nein. Die Knöpfe tun, was sie zeigen (Fernauftrag an den Primary). Einziger Nachteil im Randfall: eine zweite, ältere Oberfläche statt der normalen App. Kein Defekt; Schwere höchstens niedrig. | **D korrekt** („unerreichbar im Normalbetrieb“; Rückbau prüfen bleibt richtig) |
| L2318 client/*-Masken (11 Dateien) | `src/components/client/`: ClientInvoiceCreate, ClientCustomerForm, ClientProductForm, ClientInvoiceDetail, ClientPurchaseForm, ClientConsignmentForm, ClientOrderForm, ClientRepairForm, ClientTransferForm, ClientLifecyclePanels, client-action-panel (dazu 3 Hilfsdateien: client-invoice-request.ts, client-form-style.ts, client-form-atoms.tsx) | Einziger Importeur ist `ClientShell.tsx:17–31` (grep über `src` außerhalb von `components/client`: keine weiteren Treffer). Es gilt dieselbe Erreichbarkeit wie L2317. | Nur über den Randfall aus L2317. Schreibweg: `CommandSaveController` / `InvoiceSaveController` (ClientInvoiceCreate:26) → Fern-Ops. | Nein | **D korrekt**. Hinweis zum Rückbau: 11 Testdateien benutzen noch Alt-Bereich-Selektoren (`data-client-area`/`data-client-edit*`, 64 Treffer, u. a. `test/e2e/client-*.e2e.mjs`, `test/bridge/client-*-ui.test.ts`). Deren heutige Lauffähigkeit habe ich nicht geprüft. |
| L2319 Erstlauf-Einrichtung | `src/pages/auth/OnboardingPage.tsx:209` „Start Using LATAIF“ → `handleFinish` :26 → `db.run` tenants/branches/users/settings :39–65 | Mount nur bei `App.tsx:397` `!clientMode && needsOnboarding`. `setNeedsOnboarding(true)` steht nur in `bootDatabase` :181. Im Client-Modus kehrt der Start-Effekt bei :149–161 vorher zurück; `isFirstRunPending`/`bootDatabase` :162–165 laufen nie. | Nein (einziger Importeur App.tsx:56) | Nein | **D korrekt** (auf dem Primary aktiv bei Neuinstallation) |
| L2320 Anmelden (lokal) | `src/pages/auth/LoginPage.tsx:73` `<form onSubmit>` / :127 „Sign In“ → `handleLogin` :12 → `authStore.login` → `authService.login` (`auth.ts:82`, lokale `users`-Tabelle) | Mount nur bei `App.tsx:398` `if (!session)`. Im Client-Modus ist `!session` schon bei :366 (`null`) bzw. :367–375 (`ClientShell`) abgefangen. LoginPage wird auf PC2 also nie gerendert. | Nein (einziger Importeur App.tsx:55) | Nein | **D korrekt** |
| L2321 Datenbank zurücksetzen (Login) | `LoginPage.tsx:145–154` „Reset Database“ → `handleReset` :26 → `runGuardedReset` :39 | Dieselbe Mount-Bedingung wie L2320 | Nein | Nein | **D korrekt** (auf dem Primary aktiv und durch Backup/Sync-Sperre geschützt) |
| L2322 Erstlauf: neu / Ordner übernehmen / verbinden | `src/components/startup/FirstRunGate.tsx:125` `setUpNew` (:85), :236 `pickFolder` (:55, nur lesend), :268 `adopt` (:70), :197 Connect → `enterClientMode` | Mount nur bei `App.tsx:380` `!clientMode && firstRun`. Im Client-Modus `setFirstRun(false)` :150. | Nein (einziger Importeur App.tsx:77). Wer PC2 per Disconnect (ClientShell :153/:431 `leaveClientMode`) verlässt, ist danach kein Client mehr. Das ist gewollt. | Nein | **D korrekt** |

##### Nebenbefunde (keine D-Umklassifizierung)

1. **SSOT-Zeilennummern veraltet** für InvoiceDetail (L2134–2136): siehe die Tabelle oben. Die Nummern von SyncDuplicateGuard, ClientShell, OnboardingPage, LoginPage und FirstRunGate stimmen noch (±5).
2. **Toter `editing`-Zweig in InvoiceDetail** (:82, :266–275, :702–706, :748–833, :1186–1216) ist auf beiden Rechnern tot. Er enthält lokale `updateInvoice`-Aufrufe ohne `useSharedWrites`. Empfehlung: nach der Parität entfernen (Hygiene, keine sichtbare Wirkung).
3. **SSOT §„Keine toten Knöpfe“ Punkt 1** („Abmelden auf PC2 unmöglich“) ist im Code bereits behoben: `auth.ts:202–211` (R6B). Der Text der Liste ist veraltet. Außerhalb der D-Zeilen, nur zur Kenntnis.

#### Kategorie E

##### Audit Kategorie E — „absichtlich nicht fern“ (HEAD ac868a8, statisch, read-only)

Grundlage: `docs/central-ui-parity.md` Write-Gap-SSOT (L2124 ff.), „Keine toten Knöpfe auf PC2“ (L2324 ff.), R6B (L2372 ff.), R6F (L3090 ff.).
Weichen: `readsFromPrimary()` = `isClientMode()` (`core/data/primary-source.ts:21`); App-Routen nutzen `clientMode = isClientMode()` (`App.tsx:364`), also dieselbe Wahrheit.
`primaryOnlyDeleteProps()` → auf PC2 `disabled: true` + `title` („Deleting is only available on the main computer.“) + `data-primary-only`; `Button.tsx:56` reicht alle drei durch (`{...props}`), native `<button>` ohnehin. `blockDeleteOnClient()` → auf PC2 `alert` + `true`, der Handler kehrt vor jedem Store-Aufruf um.
Store-Löschfunktionen beginnen alle mit `getDatabase()`/`query()` (wirft auf PC2) — sie werden auf PC2 aber nie erreicht, weil der Riegel davor steht.
Unit-Nachweis: `node test/r6b/safety-existing-commands.test.ts` → **95 passed, 0 failed** (inkl. `CENTRAL_UI_R6B_UNSUPPORTED_DELETES_FAIL_CLOSED`, `…_IMPORT_CLIENT_FAIL_CLOSED_PROVED`).

Zählung: 28 Löschknöpfe + 13 Werkzeug-/Einstellungsgruppen = **41** (bestätigt).

| SSOT-Zeile | UI-Einstieg (aktueller Code) | fachlicher Grund | PC2 UI | Handler geschützt? | lokale PC2-DB? | Klassifikation |
|---|---|---|---|---|---|---|
| L2141 | Rechnung löschen — `InvoiceDetail.tsx:742` → `handleDelete` :413 | hartes Löschen mit Storno der Auto-Ausgaben/Buchungen; Löschen nach §5 nie fern | gesperrt + erklärt (Tooltip) | ja, `blockDeleteOnClient` :413 vor `deleteInvoice` | nein | E, sauber |
| L2144 | Gutschrift löschen — `CreditNoteDetail.tsx:115` → :96 | Löschen der Gutschrift (Storno-Spur); §5 | gesperrt + erklärt | ja, :96 vor `confirm()` und Store | nein | E, sauber |
| L2150 | Angebot löschen — `OfferDetail.tsx:282` → :118 | Löschen inkl. Positionen; §5 | gesperrt + erklärt | ja, :118 | nein | E, sauber |
| L2158 | Löschen (Angebotsliste) — `OfferList.tsx:247` | wie oben | gesperrt + erklärt | ja, inline :247 vor `deleteOffer` | nein | E, sauber |
| L2159 | Kunde löschen — `CustomerDetail.tsx:590` → :246 | Stammdaten-Hartlöschung mit Referenzprüfung; §5 | gesperrt + erklärt | ja, :246 | nein | E, sauber |
| L2170 | Mehrfach löschen — `WatchList.tsx:545` („Select“) → :1242 → `performDelete` :238 | Massen-Hartlöschung von Artikeln; §5 | „Select“ und Bestätigen gesperrt + erklärt; der „Delete (n)“-Knopf im Auswahlmodus (:519) trägt keine Sperre, ist aber nur über das gesperrte „Select“ erreichbar | ja, :238 vor `deleteProducts` | nein | E, sauber |
| L2174 | Artikel löschen — `ProductDetail.tsx:1568` → :523 | Hartlöschung mit Link-Prüfung; §5 | gesperrt + erklärt | ja, :523 | nein | E, sauber |
| L2188 | Lieferant löschen — `SupplierDetail.tsx:737` → :244 | Stammdaten-Hartlöschung; §5 | gesperrt + erklärt | ja, :244 | nein | E, sauber |
| L2193 | Excel-Import — Route `App.tsx:486` (Notiz); Öffner `WatchList.tsx:548–552`; `ImportPage.tsx:213` | Vor-Sicherung der eigenen DB + Massenanlage je Zeile | Route zeigt `PrimaryOnlyNotice`; „Import Excel“ gesperrt + erklärt | ja, `primaryOnlyLocked()` :213 vor Backup und `createProduct` (der eigene Knopf :467 hat keine Client-Sperre, ist auf PC2 aber nicht renderbar) | nein | E, sauber (SSOT-Ortsspalte „nicht gesperrt“ ist veraltet) |
| L2203 | Auftrag löschen — `OrderDetail.tsx:1174` → `handleDelete` :499 | Hartlöschung mit Umkehr von A/P und Gold; bezahlter Auftrag wird seit R6F storniert statt gelöscht | gesperrt + erklärt | ja, :499 **vor** der Bezahlt-Weiche; einziger UI-Aufruf `deleteOrder` :510; Storno-Pfad ruft seit R6F kein `deleteOrder` mehr (:490–494) | nein | E, sauber (R6F: bleibt E, bestätigt) |
| L2213 | Gold-Verbindlichkeit ✕ — `OrderDetail.tsx:1582` → :1575 | Löschen einer (verwaisten) Gold-Verbindlichkeit; §5 | gesperrt + erklärt | ja, :1575 vor `confirm()` | nein | E, sauber |
| L2223 | Reparatur löschen — `RepairDetail.tsx:1176` → :514 | Hartlöschung; §5 | gesperrt + erklärt | ja, :514 | nein | E, sauber |
| L2227 | Produktion löschen (Liste) — `ProductionPage.tsx:398` (onDelete :188) → Modal :361 | Löschen mit Bestandsspiegelung; §5 | gesperrt + erklärt | ja, :361 | nein | E, sauber |
| L2228 | Produktion löschen (Detail) — `ProductionDetail.tsx:71` → :191 | wie oben | gesperrt + erklärt | ja, :191 | nein | E, sauber |
| L2231 | Kommission löschen — `ConsignmentDetail.tsx:546` → :377 | Hartlöschung (nur aktive); §5 | gesperrt + erklärt | ja, :377 | nein | E, sauber |
| L2235 | Agent löschen — `AgentList.tsx:540` | Stammdaten, Referenzschutz; §5 | gesperrt + erklärt | ja, :541 vor `confirm()` | nein | E, sauber |
| L2237 | Transfer löschen (Tabelle) — `TransferTable.tsx:615` | Löschen mit Buchungsfolgen; §5 | gesperrt + erklärt | ja, :616 vor `confirm()` | nein | E, sauber |
| L2239 | Transfer löschen (Detail) — `TransferDetail.tsx:311` → :591 | wie oben | gesperrt + erklärt | ja, :591 | nein | E, sauber |
| L2243 | Metall löschen — `MetalList.tsx:396` | Storno der Metallzahlungen + Löschen; §5 | gesperrt + erklärt | ja, :397 vor `confirm()` | nein | E, sauber |
| L2248 | Schrotthandel löschen — `ScrapTradeDetail.tsx:109` → :152 | Löschen eines stornierten Handels; §5 | gesperrt + erklärt | ja, :152 | nein | E, sauber |
| L2260 | Vorlage löschen — `ExpenseList.tsx:468` → Modal :856 | Löschen der wiederkehrenden Vorlage; §5 | gesperrt + erklärt | ja, :856 | nein | E, sauber |
| L2262 | Ausgabe löschen (Liste) — `ExpenseList.tsx:546` → Modal :952 | Storno + Guthaben zurück + Löschen; §5 | gesperrt + erklärt | ja, :952 | nein | E, sauber |
| L2263 | Ausgabe löschen (Maske) — `ExpenseList.tsx:920` | wie oben | gesperrt + erklärt | ja, :921 vor `confirm()` | nein | E, sauber |
| L2269 | Partnerbewegung ✕ — `PartnersPage.tsx:184` | Löschen + Storno (nicht atomar); §5 | gesperrt + erklärt | ja, inline :184 | nein | E, sauber |
| L2271 | Partner löschen — `PartnersPage.tsx:292` | Stammdaten, Referenzschutz; §5 | gesperrt + erklärt | ja, :293 | nein | E, sauber |
| L2275 | Schuld löschen — `DebtsPage.tsx:779` → :852 | Zahlungsstorno + Löschen; §5 | gesperrt + erklärt | ja, :852 | nein | E, sauber |
| L2277 | „Storniere alle Orphans“ — `ReconciliationPage.tsx:251` | schreibt Stornos ins Hauptbuch (Buchhaltungsreparatur) | versteckt (`!readsFromPrimary()`); die Auskunft bleibt sichtbar | nur versteckt, kein eigener Riegel im Handler (unerreichbar) | nein | E, sauber |
| L2278 | Nachbuchung (20 Knöpfe) — Route `/ledger-backfill` `App.tsx:471`; Seitenleiste `Sidebar.tsx:78` | schreibt Nachbuchungen ins Hauptbuch | Link sichtbar → `PrimaryOnlyNotice`; die Knöpfe werden nie gerendert | nur die Routenweiche (Seite selbst ohne Client-Prüfung) | nein | E, sauber |
| L2279 | Hauptbuch-Prüfstand (≈43) — `/ledger-debug` `App.tsx:489` | Testbuchungen/Rohzeilen am Hauptbuch | `PrimaryOnlyNotice` | nur die Routenweiche | nein | E, sauber |
| L2287 | Mitarbeiter löschen — `EmployeeList.tsx:220` → :96 | Hartlöschung, Gehaltsreferenzen; §5 | gesperrt + erklärt | ja, :96 | nein | E, sauber |
| L2292 | Aufgabe löschen — `TaskList.tsx:666` → onDelete :518 | Löschen; §5 (Anlegen/Ändern sind fern) | gesperrt + erklärt | ja, :518 | nein | E, sauber |
| L2294 | Dokument löschen — `DocumentList.tsx:299` / :503 → :159 | Löschen des Belegs; §5 | beide Öffner gesperrt + erklärt | ja, :159 | nein | E, sauber |
| L2308 | Firma speichern — `SettingsPage` (Route `App.tsx:477`) | Hauskonfiguration (`setSetting`) | `/settings` → `PrimaryOnlyNotice` | nur die Routenweiche | nein | E, sauber |
| L2309 | Steuer/Finanzen speichern — dito | Hauskonfiguration | Notiz | nur die Route | nein | E, sauber |
| L2310 | Kategorien (3) — dito | Hauskonfiguration (Kategorien) | Notiz | nur die Route | nein | E, sauber |
| L2311 | Filialen (3) — dito | Hauskonfiguration (`db.run branches`) | Notiz | nur die Route | nein | E, sauber |
| L2312 | Benutzer (3) — dito | Rechte (`users`/`user_branches`) | Notiz | nur die Route | nein | E, sauber |
| L2313 | Nummernkreise — dito | Hauskonfiguration (Nummernkreise) | Notiz | nur die Route | nein | E, sauber |
| L2314 | Ländervorwahlen (2) — dito; außerhalb nur `PhoneInput` (liest `load`) | Hauskonfiguration | Notiz; `country-codes-store.ts:41` greift auf PC2 nicht zu | Route; `add/update/remove/saveAll` nur aus SettingsPage | nein | E, sauber |
| L2315 | Dubletten zusammenführen/löschen (4) — dito; Öffner „Find Duplicates“ `WatchList.tsx:542` | destruktives Zusammenführen/Löschen von Artikeln | Öffner sichtbar → `/settings` → Notiz (erklärt, nicht tot) | nur die Route | nein | E, sauber |
| L2316 | Reparatur-Prüfstand (2) — `/admin/repair-flow-test` `App.tsx:423` | Testszenarien + Test-Purge direkt in der DB | `PrimaryOnlyNotice` | nur die Route | nein | E, sauber |

##### Ergebnis

- Geprüft: **41/41**, sauber: **41/41**.
- Spät scheiternde sichtbare PC2-Knöpfe (erst Modal/Confirm, dann Fehler aus `getDatabase`): **keine.** Jeder Lösch-Öffner ist auf PC2 gesperrt. Bei Knöpfen mit `confirm()` (Gutschrift, Metall, Agent, Transfer-Tabelle, Ausgabe-Maske, Gold ✕) steht der Riegel VOR dem Dialog.
- Fehlklassifikation: **keine.** „Auftrag löschen“ ist nach R6F weiter E und geschützt (:499 vor der Bezahlt-Weiche).
- Lokaler DB-Griff auf PC2: **keiner.** Alle Store-Aufrufe liegen hinter Riegel oder Route. Ländervorwahlen lesen auf PC2 nicht.
- Hinweise, kein Defekt:
  1. Die SSOT-Ortsspalte des Imports (L2193) sagt noch „`/import`, nicht gesperrt“. Die Punkte 2–3 in „Nicht sauber“ (L2334–2338) beschreiben den R6A-Stand und sind durch R6B überholt. Doku-Drift, niedrig.
  2. Die SSOT-Zeilennummern weichen vom Code ab (z. B. `InvoiceDetail:697→1671` gegenüber real :742/:413; `OrderDetail:1116→1880` gegenüber :1174/:499). Niedrig.
  3. R6B-Doku (L2465) nennt 97/0 für `r6b/safety-existing-commands`, der aktuelle Lauf zeigt 95/0 (grün). Niedrig.
  4. Die Werkzeugseiten (Settings, Backfill, LedgerDebug, RepairFlowTest) und der Orphan-Storno haben keinen eigenen Handler-Riegel. Sie hängen allein an Route bzw. Ausblendung und als letzte Linie am `getDatabase`-Wurf. Heute nicht erreichbar, daher nur Härtungsoption, niedrig.

## Post-Parity R7A — Business Correctness (14.09.2026)

Stand `51f1f5d` + R7A, Version **0.8.54**, kein Release. Umfang ausschließlich PP-1, PP-2, PP-8, PP-9, PP-10, PP-11 aus dem
Post-Parity-Backlog; PP-3, PP-4, PP-5, PP-6, PP-7, PP-12 bleiben offen.

```
PP vorher offen   12
R7A Scope          6   (PP-1, PP-2, PP-8, PP-9, PP-10, PP-11)
geschlossen        6
verbleibend        6   (PP-3, PP-4, PP-5, PP-6, PP-7, PP-12)
Registry          174 → 175   (1 Probe + 71 Auskünfte + 103 Buchungen; neu: production.complete)
```

| ID | Befund | Behebung | Beweis |
|---|---|---|---|
| PP-1 | Nach einer STORNIERTEN Guthaben-Einlösung zeigt deren Zahlungszeile (Historie) auf eine später rechtmäßig abgewickelte Guthabenzeile → `bad_reference` (error), vorher schon `used_drift`; Salden korrekt. Erreichbar auch über die normale Maske/PC2 (Retoure als Guthaben → Einlösung → Storno der Einlösung → Storno des Retouren-Einkaufs; oder Erstattung eines Standalone-Guthabens) | `counterpartyAudit`: eine Einlösung, deren Buchung (`PURCHASE_PAYMENT`/`EXPENSE_PAYMENT`) vollständig gegengebucht ist, ist Historie — zählt nicht zu `applied`, wird nicht auf ihre Guthabenzeile geprüft. Lebende Einlösungen voll geprüft; der Prüfer schreibt nichts, keine Löschhistorie erfunden | `test/r7a/pp1-supplier-credit-reconciliation.test.ts` (Teil-/Vollnutzung, storniert, reproduzierter Befund, gemischt, echte Abweichungen: fehlende Zeile, used_drift, overused, ohne Referenz); R6F-Vertrag §5 umgestellt |
| PP-2 | Der Abschluss (Arbeit + Gemeinkosten) hatte keinen Aufrufer; der alte Store-Weg ohne Klammer, verschluckte Buchungen, stilles `branch-main`, zweimal aufrufbar | Neue Hausfolge `completeProductionInHouse` + Fernbefehl `production.complete` + „Complete Production" in `ProductionDetail` (Primary und PC2 dieselbe Weiche). Nur ein CONFIRMED-Beleg dieser Filiale; genau EINE Ausgabe (Miscellaneous, bar bezahlt, `related_module 'production'`) über `createExpenseInHouse` (beide Buchungen strikt); `total_cost` rechnet der Primary; Einstand der Fertigteile bleibt der Materialwert (Arbeit/Gemeinkosten = Aufwand, nicht doppelt); zweiter Abschluss = `PRODUCTION_ALREADY_COMPLETED`; Altstand mit Ausgabe = `PRODUCTION_ALREADY_BOOKED`. `productionStore.completeRecord` entfernt | `test/r7a/pp2-pp10-production.test.ts` §1–§7 (Parität, genau einmal, verlorene Antwort, Beträge, Fehlerinjektion an vier Stellen, Autorität, Filiale, Client-Riegel, Löschen danach) |
| PP-8 | Der Auftragsstorno löschte die Überzahlungs-Gutschrift HART (kein Protokoll) und zog ihren Betrag in den Storno — bei „Verfall" verfiel auch Kundenguthaben | `customer_credits` ist ein eigenes Finanzobjekt: Refund zahlt alles zurück und STORNIERT die Gutschrift (Zeile bleibt, `CANCELLED`, Protokoll, Reklass-Bein gegengebucht); Credit/Verfall lassen sie unberührt beim Kunden, die Wahl gilt nur für die Anzahlung. Maske zeigt, was mit der Überzahlung geschieht (`data-order-cancel-overpay`) | `test/r7a/pp8-pp9-order-credit-delete.test.ts` (drei Wahlen × Primary/PC2, Parität, Sperre bei eingelöster Gutschrift, verlorene Antwort, Fehlerinjektion nach dem Gutschrift-Storno, Akteur) |
| PP-9 | „Delete Order" (Primary-only) stornierte jede offene Gramm-Schuld — auch geliefertes/teilweise beglichenes Gold — und ließ eine beglichene mit Verweis auf den gelöschten Auftrag stehen | `orderDeleteBlocker`: geliefertes (ARRIVED/DELIVERED), bewegtes oder beglichenes Gold → `ORDER_DELETE_GOLD_MOVED`; eine bezahlte Kostenposition → `ORDER_DELETE_COSTS_PAID` (sonst verschwände eine Zahlung ohne Gegenbuchung). Prüfung VOR jedem Schreiben, Maske nennt den Grund, der Weg ist „Cancel Order". Nur reine Planung fällt mit dem Auftrag weg | dieselbe Datei (Planung erlaubt, geliefert/bewegt/beglichen gesperrt ohne Schreibwirkung, Storno danach möglich, Kosten bezahlt/unbezahlt) |
| PP-10 | `production_inputs`/`production_outputs` standen nicht im Abgleich-Manifest und wurden von keinem Schreiber nachgeführt — ein anderer Datenbank-Rechner sah Belege ohne Ein-/Ausgänge, Löschen hinterließ dort Waisen | Beide Tabellen im Manifest (`insert`/`delete`, genau die Spalten), nachgeführt beim Anlegen (`production-house`) und Löschen (`deleteRecord`), `KNOWN_BUSINESS_TABLES` und Modulzuordnung ergänzt; kein Parallel-Sync | `test/r7a/pp2-pp10-production.test.ts` PP-10 (Schreiber, Weitergabe Zeile für Zeile, Echo ohne Schreiben, Löschen ohne Waisen, Feldvertrag, Cursor-Regel); Manifest-/Klassifikations-Gates 52/37 |
| PP-11 | Die Aufgabenmaske zeigte „NOTES", der Text wurde verworfen | Spalte `tasks.notes` (additive Migration), derselbe Rumpf `tasks.create`/`tasks.update` (keine neue Fähigkeit), Manifest-Feld, Maske lädt die gespeicherte Notiz | `test/r7a/pp11-task-note.test.ts` (Primary/PC2, Parität, verlorene Antwort, veraltete Fassung, Akteur, Auskunft, Echo ohne Fassung, anderer Datenbank-Rechner) |

**Transaktionen/Sicherheit (PP-1/2/8/9):** der Primary bleibt Autorität und einziger Schreiber; kein Rumpf nennt Summen,
Kosten, Buchungen oder Urheber (`the primary decides …`); jede Handlung in EINER Klammer (Fehlerinjektion: nichts
Halbes); verlorene Antwort → dieselbe `commandId` → eingefrorenes Ergebnis; fern handelt der geprüfte PC2-Absender.

**Zwei-Rechner-Lauf:** `test/e2e/r7a-business-correctness.e2e.mjs` — **207/0** (E2E-Programme einmal nach fertigem
Produktcode gebaut). Alle sechs Handlungen auf PC2 (als B) UND am Primary (als A): `purchases.cancel` (Storno der Einlösung,
dann Rücknahme der Retoure — die Abstimmung auf PC2 und am Primary ohne bad_reference/used_drift), `orders.cancel` (Verfall
eines überzahlten Auftrags: die Gutschrift 300 bleibt dieselbe Zeile, OPEN), `production.create` + `production.complete`
(genau eine Ausgabe 7.5, Einstand 250 unverändert), `tasks.create`/`tasks.update` mit Notiz (die Maske lädt sie); „Delete
Order" mit geliefertem Gold am Primary gesperrt (nichts geschrieben), auf PC2 gesperrt (Primary-only); Ein-/Ausgänge und
Abschluss im Abgleich des Primary-Servers, nichts in Quarantäne. Vier verlorene Antworten (`purchases.cancel`,
`orders.cancel`, `production.create`, `production.complete`) je genau eine Wirkung, Akteur-Fehler 0, Hauptbuch des Laufs
68 Zeilen / 34 Transaktionen ausgeglichen, PC2 ohne lokale Datenbank (alte `lataif.db` unberührt), Produktions-App,
`E:\LATAIF\Data` und Ports 3001/3443 unberührt. Marker `POST_PARITY_R7A_PP1/PP2/PP8/PP9/PP10/PP11_RUNTIME_PROVED`,
`POST_PARITY_R7A_LOST_RESPONSE_PROVED`, `POST_PARITY_R7A_TWO_APP_PROVED`.

**Kostenvertrag der Fertigung** (`POST_PARITY_R7A_PRODUCTION_ACCOUNTING_CONTRACT_PINNED`, pp2-pp10 §8): Material 250,
Arbeit 150, Gemeinkosten 50 → Beleg `total_cost` 450; Einstand der Fertigteile 150/100 = Materialwert (die Fertigung ist
wertgleich und bucht weder INVENTORY noch COGS); EINE Ausgabe 200 „Miscellaneous", bar (Soll EXPENSES_OPERATING / Haben
Kasse, A/P 0), nicht in `CAPITALIZED_EXPENSE_CATEGORIES`; späterer Verkauf 400 + 300: COGS 250 zum Los-Einstand, Marge 450 −
Betriebsausgaben 200 = Hauptbuch-Gewinn 250 = Erlös 700 − `total_cost` 450. Warum der Materialwert: das Hausmodell führt als
Wareneinsatz nur den Einstand (Los bzw. `purchase_price`) und die kapitalisierte Kategorie „Inventory"; Arbeit/Gemeinkosten
zu kapitalisieren bräuchte eine Buchung Soll INVENTORY, die es nicht gibt — zusammen mit der Ausgabe zählte sie doppelt
(Gewinn 50), ohne sie liefe INVENTORY gegen die Lose auseinander. Vertrag bestätigt, keine Domänenänderung.

**Gates:** `test/r7a/` pp1 19/0 · pp8-pp9 54/0 · pp2-pp10 59/0 · pp11 22/0; Rust `bridge`/`sync_policy`/`sync_schema` 60/0;
Node-Sweep vor der Triage 195/197. Die zwei Fehlschläge (`bridge/product-durability-ownership`,
`uiparity/r4c1-role-parity`) sind **Klasse A (veraltete Zählpins), nicht R7A**: an `51f1f5d` identisch reproduziert (gleiche
Datei, gleiche Assertion, gleiche Meldung, gleicher Aufrufweg; einziger Unterschied die Zählung 102 → 103 durch
`production.complete`). Erwartung auf den heutigen Vertrag gezogen (103 Buchungen, der R5F.1-Kern steht unverändert vorn);
beide grün (70/0, 35/0). Typcheck grün, Lint-Stand unverändert (7 Altfehler wie HEAD).

```
Category A = 0 · Category B = 0 (unverändert)
Registry   = 175 (1 + 71 + 103)
Post-Parity-Backlog: geschlossen PP-1, PP-2, PP-8, PP-9, PP-10, PP-11 · offen PP-3, PP-4, PP-5, PP-6, PP-7, PP-12
Version 0.8.54 · kein Release
```

## PP-13 — Eigene Reparatur mit Werkstatt: doppelte Kosten (Untersuchung 14.09.2026)

`OWN_REPAIR_WORKSHOP_DOUBLE_COST_INVESTIGATION_COMPLETE` — **bestätigt, noch nicht repariert.** Reproduziert am echten
Primary-Weg (`createRepairOnPrimary` → `addRepairLine` → `updateStatus` in_progress/ready → `createDirectInvoice`) auf einer
sql.js-Datenbank mit Schema und Migrationen; Artikel-Einstand 0, Verkauf 300, Werkstatt 100, keine weiteren Kosten.

**Doppelter Aufrufweg:**
1. **Erste Wirkung — Betriebsausgabe:** `repairStore.updateStatus` → `in_progress`/`sent_to_workshop` (`repairStore.ts:819–833`,
   ebenso `addRepairLine` in diesen Stufen, `:1324–1331`) → `commitRepairLineExpenses` (`:390–474`) → Ausgabe `RepairCosts` 100
   (Werkstatt, PENDING) + `postExpense` (`posting.ts:1348`): Soll EXPENSES_OPERATING 100 / Haben ACCOUNTS_PAYABLE 100.
2. **Zweite Wirkung — Einstand:** `updateStatus` → `ready`, Zweig OWN (`repairStore.ts:853–892`) → `computeRepairTotalCost`
   (`:175`, external + Zeilen = Zeilensumme 100) → `products.purchase_price` +100 und `stock_lots.unit_cost` +100 → beim
   Verkauf löst `createDirectInvoice` den Los-Einstand auf (`invoiceStore.ts:276–292`) → `purchase_price_snapshot` 100 →
   `postInvoiceIssued` Soll COGS 100 / Haben INVENTORY 100 (`posting.ts:572–594`); Berichte: Marge 300 − 100.

Beides sind **echte finanzielle Wirkungen**, keine Darstellung: EXPENSES_OPERATING UND COGS im Hauptbuch; in den Berichten
Marge (Einstand) UND Betriebsausgabe (`RepairCosts` steht nicht in `CAPITALIZED_EXPENSE_CATEGORIES`). Der Kommentar am
Einzelweg („Kosten sind bereits kapitalisiert", `repairStore.ts:915–916`) nimmt genau das an, bucht die Werkstattschuld aber
trotzdem als Betriebsausgabe.

| Fall | Einstand nach „ready" | Ausgabe | Gewinn Hauptbuch | Gewinn Berichte | Soll |
|---|---|---|---|---|---|
| A ohne Werkstatt (internal, eigene Kosten 100) | 100 | — | 200 | 200 | 200 ✓ |
| B Werkstatt-Zeile 100, unbezahlt | 100 | 100 (A/P 100) | **100** | **100** | 200 ✗ |
| C Werkstatt-Zeile 100, bezahlt (Kasse −100) | 100 | 100 PAID | **100** | **100** | 200 ✗ |
| D Werkstatt Einzelweg (`estimatedCost` 100), unbezahlt | 100 | 100 (A/P 100) | **100** | **100** | 200 ✗ |
| E Einzelweg, bezahlt | 100 | 100 PAID | **100** | **100** | 200 ✗ |
| F = B, Werkstattzeile nach „ready" storniert | **100 bleibt** | Ausgabe gelöscht + gegengebucht | 200 | 200 | 300 (keine echten Kosten) ✗ |

Die Zahlung ändert nichts am Fehler (nur Soll A/P / Haben Kasse). Nebenbefunde (kein Doppel): in A–E steht INVENTORY nach dem
Verkauf auf −100, weil die Kapitalisierung nie Soll INVENTORY bucht (in A fließen die eigenen Kosten auch nicht über
Kasse/Bank ins Hauptbuch); F zeigt, dass der Zeilenstorno die Kapitalisierung nicht zurücknimmt.

**Soll-Vertrag:** Die Kosten einer Reparatur an EIGENER Ware sind Anschaffungsnebenkosten des Artikels und wirken genau
EINMAL — über den Einstand (Los/`purchase_price`) als COGS beim Verkauf. Die Werkstattschuld einer OWN-Reparatur bucht
Soll INVENTORY / Haben A/P (Werkstatt), nicht EXPENSES_OPERATING, und zählt in den Berichten als kapitalisiert, nicht als
Betriebsausgabe; die Zahlung bleibt Soll A/P / Haben Kasse/Bank; ein Storno der Zeile/Gebühr nimmt die Kapitalisierung zurück.
Ergebnis: 300 − 100 = **200** im Hauptbuch und in den Berichten, INVENTORY deckungsgleich mit den Losen. Folgefrage (nicht
Teil dieser Untersuchung): der Rechnungsweg der KUNDEN-Reparatur (Einstand = `internalCost` + Zeilensumme, `repair-cost.ts`
C3H) gegen dieselben Zeilenausgaben prüfen.

## PP-13 — Behebung: eigene Reparatur, Werkstattkosten genau einmal (14.09.2026)

`POST_PARITY_PP13_OWN_REPAIR_CAPITALIZATION_CONTRACT_PROVED` · `POST_PARITY_PP13_REPAIR_COST_REVERSAL_PROVED` — Registry
unverändert **175** (keine neue Fähigkeit), Version 0.8.54.

**Vertrag — EINE Regel für Zeilen- und Einzelweg (`core/repairs/own-repair-cost.ts`):** die Werkstattschuld einer Reparatur an
EIGENER Ware ist eine Ausgabe „Inventory" mit Bezug 'repair' (`repairCostCategory`, `isCapitalizedRepairCost`) → `postExpense`
Soll INVENTORY / Haben A/P (Werkstatt); die Berichte führen „Inventory" als kapitalisiert, nicht als Betriebsausgabe. Bei
„ready" geht `ownRepairCost` in Artikel + Los (`shiftOwnRepairCost`), beim Verkauf als COGS genau einmal hinaus; die Zahlung
ist nur Soll A/P / Haben Kasse/Bank. Zeile nach „ready", Betragsänderung, Zeilenstorno und Löschen der Reparatur verschieben
den Einstand über denselben `shiftOwnRepairCost`; jede Rücknahme wird VOR dem Schreiben geprüft: bezahlt → `REPAIR_COST_PAID`,
verkauft → `REPAIR_COST_ALREADY_SOLD`, nie negativ. Ohne verknüpfte Werkstatt gibt es keine Werkstattkosten mehr (kein Einstand
aus dem gespiegelten `internalCost`); bei „hybrid" an eigener Ware spiegelt die Anlage den Voranschlag nicht mehr in die eigenen
Kosten (die Werkstattzeile trägt ihn — sonst Einstand 200 statt 100; dieselbe Regel wie `internalCostOnEdit`). Die kapitalisierte Ausgabe ändert/löscht nur ihre Reparaturzeile
(`EXPENSE_REPAIR_COST_LOCKED`); keine Reparaturausgabe wechselt über die Kategorie zwischen Aufwand und Bestand.

**Klammer:** Status, Zeile hinzufügen und Zeile stornieren laufen am Primary über `repair-house` (`amPrimary` +
`watchLedgerPosts`), fern über dieselben Store-Funktionen in `runRemoteCommand` mit derselben Buchungswache — auch ein im
Store abgefangener Buchungsfehler nimmt die ganze Handlung zurück.

**Beweis `test/pp13/own-repair-cost.test.ts` 67/0** (Einstand 0, Werkstatt 100, Verkauf 300): Primary == PC2 — nach „in
Arbeit" INVENTORY 100 / A/P 100, Aufwand 0; nach „ready" Artikel + Los 100; Verkauf COGS 100, INVENTORY 0, **Gewinn Hauptbuch
200 == Berichte 200**; bezahlt nur A/P −100 / Kasse −100, Einstand wie unbezahlt; Einzelweg identisch; verlorene Antwort →
eingefroren, Einstand 100 (nicht 200), ein neuer „ready" = Nein; Fehlerinjektion bei der Buchung und am Los → nichts Halbes,
der zweite Versuch wirkt genau einmal; Storno vor „ready" → kein Einstand; nach „ready" unbezahlt → Einstand, Los, INVENTORY
und A/P gemeinsam zurück; bezahlt / verkauft → Nein ohne Schreiben; Zeile nach „ready" +50 / Storno −50; Betrag 100 → 120 (PC2);
Löschen nimmt zurück bzw. ist gesperrt; Akteur fern = geprüfter PC2-Absender. Eigene Arbeit ohne Werkstatt unverändert
(Einstand 100, keine Ausgabe, Gewinn 200; bekannt: ohne Bestandsbuchung steht INVENTORY danach −100 — keine Doppelzählung,
eigene Frage). Kundenreparatur von PP-13 unberührt.

**Nachbarn:** r5c 286/0 (Klammer-Pin 3 → 6), R4C-Matrix 456/0 (lokale Namen → Hausfunktionen), service-parity, service-documents,
lifecycle-actions, payables, gold, metal/scrap, order, supplier-credit, r7a — grün; Typcheck grün; Lint ohne neue Fehler.
Altbestand (frühere „RepairCosts" eigener Reparaturen) bleibt, wie er gebucht ist — keine Umbuchung.

**Kundenreparatur-Nachbar → PP-14 (neu, offen, nicht behoben):** gemessen am Rechnungsweg — Rechnung 300, Werkstatt 100 →
Rechnungseinstand 200 (`internalCost`-Spiegel 100 + Werkstattzeile 100, `repairInvoiceLineCost`), COGS 200, Aufwand 100,
INVENTORY −200, Gewinn 0 statt 200. Fachlich eigenständig (Dienstleistung ohne Bestand; Erlös über Rechnung MIT COGS oder
Direktzahlung `REPAIR_PAYMENT` OHNE COGS — der Einstand des einen Wegs ist im anderen falsch) → eigene Entscheidung, keine
Ausweitung in PP-13. `POST_PARITY_REPAIR_CUSTOMER_COST_CONTRACT_PROVED` wird deshalb NICHT vergeben.

## PP-13 + PP-14 — Repair-Accounting-Abschluss (14.09.2026)

**Gemeinsame Ursache:** derselbe Kostenbetrag wirkte über mehrere Wege — Ausgabe (Soll EXPENSES_OPERATING), Einstand eigener
Ware, gespiegelter `internalCost` (`internalCostOnCreate` bei „external"/„hybrid") und der Wareneinsatz der Reparaturrechnung
(`internalCost` + Zeilen, Haben INVENTORY auch für Kundenware). Eigene Ware 300/100 ergab 100, Kundenware 300/100 ergab 0.
`POST_PARITY_REPAIR_COST_DOMAIN_PROVED`

**EINE Domain (`core/repairs/repair-cost.ts` `repairCostParts` + `core/repairs/repair-cost-booking.ts`):** die Kosten einer
Reparatur sind drei Teile — eigene Arbeit (`internalCost`, außer bei „external": dort der Spiegel), jede offene Kostenzeile
(Werkstatt oder im Haus), und nur ohne Zeilen mit verknüpfter Werkstatt die Gebühr (Altbestand). Jeder Teil ist genau EINE
Ausgabe: Zeilen bei „in Arbeit"/„an Werkstatt" bzw. beim Hinzufügen danach, eigene Arbeit und Gebühr bei „ready"
(`syncRepairHeaderCosts`, danach folgen sie jeder Änderung). Werkstatt → A/P an sie; ohne Werkstatt bezahlt über
`internal_paid_from`, sonst offen — dasselbe Muster wie die Werkstattgebühr des Hauses. Dieselbe Summe ist Einstand eigener
Ware, Marge und Rechnungseinstand (`computeRepairTotalCost` delegiert). Ohne Zeile und ohne Werkstatt ist ein Voranschlag keine
Kosten.

**Zwei Buchungsverträge nach Eigentum (`repairCostAccount`, `postExpense`):**
- **Eigene Ware (PP-13)** — Kategorie „Inventory" → Soll INVENTORY / Haben A/P; bei „ready" Artikel + Los um genau diese Summe;
  Verkauf 300 → COGS 100 (Los-Einstand), INVENTORY zurück auf 0, Gewinn 200. Auch die eigene Arbeit ohne Werkstatt
  (`POST_PARITY_PP13_INTERNAL_REPAIR_CAPITALIZATION_PROVED`: Einstand 100 = INVENTORY +100, nach dem Verkauf 0).
- **Kundenware (PP-14)** — Kategorie „RepairServiceCost" (legt nur die Reparatur an, in `CAPITALIZED_EXPENSE_CATEGORIES` =
  nicht operativ) → Soll COGS / Haben A/P; nie Bestand. Die Reparaturrechnung (`svc-repair-…`) bucht KEINEN zweiten
  Wareneinsatz (`postInvoiceIssued`, `postInvoiceCogsBackfill`); Rechnung 300 → Einstand 100, Marge 200, Gewinn 200 — ebenso
  bei Direktzahlung ohne Rechnung (`REPAIR_PAYMENT`: Erlös 300, COGS 100). `POST_PARITY_PP14_CUSTOMER_REPAIR_ACCOUNTING_PROVED`
- Die Zahlung ist nur Soll A/P / Haben Kasse/Bank (Gewinn vor und nach der Zahlung gleich). Analytics zählt gebuchte eigene
  Arbeit nicht zusätzlich als Reparatur-Abfluss.

**Gegenkonto der eigenen Kosten (Final Counteraccount Pin, `POST_PARITY_PP13_PP14_COUNTERACCOUNT_PINNED`):** Die Maske
definiert die Kostenzeile ohne Werkstatt als „🏠 In-house / Own work — own labor / own stock" mit dem Hinweis „(no A/P
booking)"; die eigenen Kosten haben den Zahlweg „INTERNAL PAID FROM: None | Cash | Bank | Benefit" (Schema: „our cost (parts,
labor)"); Analytics zählte sie nur mit Zahlweg als Abfluss. Also: **ohne Zahlweg** (und jede Zeile im Haus) ist das kein
Zahlungsanspruch und kein Geldfluss — die Kosten stecken schon in gebuchten Betriebsausgaben (Lohn, Material, Metallkauf) und
werden **aktiviert** (Quelle `REPAIR_OWN_WORK`, `postRepairOwnWork`): Soll INVENTORY (eigene Ware) bzw. COGS (Kundenware) /
Haben EXPENSES_OPERATING — keine Verbindlichkeit, keine Kasse. **Mit Zahlweg** real bezahlt: EINE Ausgabe gegen Kasse/Bank (A/P
nur durchlaufend, netto 0). Nur die Werkstatt ist A/P. Korrigiert gegenüber `8581e1c`: dort entstand für eigene Arbeit ohne
Zahlweg eine offene Ausgabe ohne Gläubiger (künstliche Verbindlichkeit). Beispiel 100 ohne Zahlweg, eigene Ware: Einstand/Los
100, INVENTORY +100 / EXPENSES_OPERATING −100, Verkauf 300 → COGS 100, INVENTORY 0, Rohertrag 200 == Marge 200; mit dem schon
gebuchten Lohn 100 Gewinn 200, der Betrag wirkt genau einmal. Kundenware: COGS 100 statt Bestand, Rechnung 300 → Marge 200.
Abstimmung (hybrid: eigene 20 + Werkstatt 100 + im Haus 30 = 150, beide Eigentumsarten, bar/ohne Zahlweg): Quelle 150 ==
INVENTORY bzw. COGS 150, A/P 100 (nur die Werkstatt), Kasse −20 nur wenn bezahlt, Eigenleistung −50/−30, Einstand und COGS 150,
Marge 150 == Rohertrag 150, keine Reparaturkosten als Betriebsausgabe. Eine Rücknahme prüft zuerst alles (auch die Gold-Regel)
und schreibt erst dann.

**Rücknahme (`POST_PARITY_PP13_REPAIR_COST_REVERSAL_PROVED`, `POST_PARITY_PP14_CUSTOMER_REPAIR_REVERSAL_PROVED`):** vor „ready"
→ Ausgabe gegengebucht, danach kein Einstand; nach „ready" unbezahlt → Einstand, Los, INVENTORY, A/P gemeinsam zurück; Zeile nach
„ready" +/−, Betrag geändert (Differenz), Reparatur gelöscht (zurück); Kopfkosten nach „ready" geändert → dieselbe Ausgabe
(Storno + Neubuchung) und Einstand/Marge um die Differenz. Gesperrt ohne Schreiben: beglichen → `REPAIR_COST_PAID`, verkauft →
`REPAIR_COST_ALREADY_SOLD` (auch keine neue Zeile), abgerechnet → `REPAIR_ALREADY_INVOICED`, nie negativ. Rechnungsstorno:
Erlös zurück, die Werkstattarbeit bleibt EINE Kostenwirkung (COGS, A/P an die Werkstatt). Gebuchte Reparaturkosten ändert oder
löscht nur die Reparatur (`EXPENSE_REPAIR_COST_LOCKED`, `EXPENSE_CATEGORY_RESERVED`).

**Atomarität:** Status, Zeile hinzufügen/stornieren und „Save" laufen am Primary über `repair-house` (`amPrimary` +
`watchLedgerPosts`), fern über dieselben Store-Funktionen in `runRemoteCommand` mit derselben Buchungswache; ein im Store
abgefangener Buchungsfehler nimmt die ganze Handlung zurück. Registry unverändert **175**.

**Beweis:** `test/pp13/repair-cost-accounting.test.ts` **104/0** (Domain, eigene Ware Zeilen-/Einzelweg/hybrid/eigene Arbeit,
Kundenware Werkstatt/bezahlt/eigene Arbeit/Direktzahlung, alle Rücknahmen, verlorene Antwort, Fehlerinjektion, Primary == PC2,
Hauptbuch == Berichte, `POST_PARITY_REPAIR_LEDGER_REPORT_PARITY_PROVED`). Zwei-Rechner-Lauf
`test/e2e/pp14-repair-cost-accounting.e2e.mjs` **301/0** (frische E2E-Programme, einmal gebaut): eigene Ware + Werkstatt
(in Arbeit → an Werkstatt → fertig mit verlorener Antwort: Artikel + Los 100 genau einmal), eigene Arbeit, Kundenware + Werkstatt,
Zahlung, Rechnung (Einstand 100, Marge 200, kein Wareneinsatz auf der Reparaturrechnung), Storno der unbezahlten Zeile, Nein für
die bezahlte (`REPAIR_COST_PAID`), Verkauf der eigenen Ware (COGS 100, INVENTORY 0, Marge 200) — jede Handlung auf PC2 (B)
UND am Primary (A), Akteur-Fehler 0, Hauptbuch 52 Zeilen / 22 Transaktionen ausgeglichen, PC2 ohne lokale Datenbank, Produktions-
App, `E:\LATAIF\Data` und Ports 3001/3443 unberührt (`POST_PARITY_PP13_PP14_TWO_APP_PROVED`). Nachbarn grün (r5c 286/0, service-parity,
service-documents, lifecycle-actions 200/0 mit nachgezogenem Einstand-Pin, payables, gold, metal, order, invoice-cancel, returns,
r7a, invoice-lifecycle, credit-note, offer, analytics); Typcheck grün; Lint ohne neue Fehler.

```
Post-Parity-Backlog: geschlossen PP-1, PP-2, PP-8, PP-9, PP-10, PP-11, PP-13, PP-14 · offen PP-3, PP-4, PP-5, PP-6, PP-7, PP-12
Registry = 175 · Version 0.8.54 · kein Release
```

## Post-Parity R7B — Plattform / Laufzeit / Härtung (14.09.2026)

Umfang: die sechs offenen Backlog-Punkte PP-3, PP-4, PP-5, PP-6, PP-7, PP-12. Keine neue Fernbuchung, Registry unverändert
**175** (TS == Rust). PP-1/2/8/9/10/11/13/14 bleiben geschlossen und unberührt.

| ID | Befund (bestätigt) | Behebung | Beweis |
|---|---|---|---|
| PP-3 | Alle KI-Aktionen riefen OpenAI direkt aus dem Fenster, mit dem Schlüssel DIESES Rechners (`lataif_openai_key` / `<Datenort>/openai.key`); auf PC2 gab es keinen (Settings gesperrt) → Fehler erst nach dem Klick. Der Primary hat mit `/api/ai/identify` bereits eine Erkennung mit SEINEM Schlüssel (MOBILE-I1C). | Erkennen (NewProductModal, WatchList, ProductDetail, ConsignmentList) läuft auf PC2 ÜBER den Primary: `identify-adapter` → `primary-ai.ts` → `/api/ai/identify` (Kategorie, Foto-Bytes, Hinweise; ein gespeichertes Hauptbild als geprüfte Bytes über `/api/media`); zurück kommt die freigegebene Teilmenge (nie Preis/Menge/Kennung). Neu `GET /api/ai/status` (ja/nein aus demselben Schlüssel, nie zurückgegeben) → der Knopf ist VOR dem Klick gesperrt, mit Grund (nicht eingerichtet / nicht erreichbar / kein Foto). `getApiKey()` gibt auf PC2 nie einen Schlüssel zurück, auch keinen alten eigenen. Bewusst NICHT fern (vom Auftrag ausdrücklich zugelassen: „auf PC2 vor dem Klick hidden/disabled mit Grund"; SSOT-Zeile PP-3: „…oder auf PC2 sperren/erklären"): Preisvorschlag, Nachrichtentext, Angebotstext, Assistent `/ai` — auf PC2 vor dem Klick gesperrt mit Grund (`AI_TEXT_ON_PRIMARY`), `/ai` = `PrimaryOnlyNotice`; der Text bleibt von Hand schreibbar. Begründung am Callpath: ein Fernbefehl läuft im Fenster des Primary über `businessWriteScheduler` — als Auskunft in `runShared` (zählt als Leser), und jede Buchung (`run`/`runExclusive`) wartet in `readersDrained()`, bis alle Leser fertig sind; als Buchung läuft er selbst exklusiv. Die Sekunden der externen KI-Antwort stünden damit in der Schreibreihenfolge des Primary (keine DB-Transaktion, kein DB-Lock — die Sperre ist die Leser-/Schreiberordnung des Planers). Ein Rust-Weg wie `/api/ai/identify` bräuchte die Vorgaben dieser drei Texte im gemeinsamen Vertrag (heute nur in `ai-service.ts`) — das wäre neuer Umfang. | `test/r7b` §1; Rust `ai_route_tests` (`key_present`, Status-Route), `w4`-Routenliste; Zwei-Rechner-Lauf PP-3 |
| PP-4 | Fällige Daueraufträge nur bei Start/Filialwechsel und beim Öffnen der Ausgabenliste; der Startlauf lief an der Schreibreihenfolge vorbei (nicht durabel). | `core/payables/recurring-scheduler.ts`: am Primary jede Minute die Frage nach dem ÖRTLICHEN Tag; ein neuer Tag → der bestehende Generator `runDueGeneratorOnPrimary(now)` (Schreibreihenfolge, danach durabel). Genau einmal: Monatszeiger + Monatsprüfung in derselben Klammer; ein nicht fertiger Lauf (fremde Klammer, niemand angemeldet, Wurf) schließt den Tag nicht; Takte überholen sich nicht. Der Startlauf geht jetzt ebenfalls über `runDueGeneratorOnPrimary`. Keine neue Regel, kein externer Dienst, nie auf PC2. | `test/r7b` §2 zeitgesteuert: drei Monate nachgeholt, derselbe Tag nichts, Neustart (Datei neu geöffnet) nichts doppelt, 30.09. 23:59 / 01.10. 00:00 Ortszeit, stornierter Monat kommt nicht wieder, Pause/Resume ohne Nachholen, offene Klammer → nächster Takt, Hauptbuch ausgeglichen |
| PP-5 | „Trennen" ließ `lataif_session` stehen; ein 401/403 warf nur den Ausweis weg; der Primary-Start übernahm eine gespeicherte Sitzung ungeprüft (fremdes JWT, fremde Filiale, fremde Rolle). Der Server führt keine Sitzungen (zustandsloser Ausweis, C4 `reauthorize` je Anfrage) — dort ist nichts zu entfernen und keine andere Sitzung zu beschädigen. | `leaveClientMode` und `setClientToken(null)` nehmen die Sitzung mit; ein Ausweis ohne brauchbare Sitzung wird verworfen (Start und Anmeldung); Abmelden auf PC2 vergisst laufende Fernladungen (`resetPrimarySource`) und baut das Fenster neu; `authService.verifyStoredSession()` am Primary-Start: gültig nur, wenn DIESE Datenbank das Token ausgestellt hat (`sessions.token`), der Benutzer aktiv ist und die Filiale hat — die Rolle frisch aus `user_branches`; sonst verworfen → Anmeldung (der Grund steht im Protokoll, nie das Token). | `test/r7b` §3; Zwei-Rechner-Lauf PP-5 |
| PP-6 | Die sechs Maschinenflächen hatten keinen eigenen Handler-Riegel (geschützt über Route, fehlenden Fernweg, DB-losen PC2). | Gemeinsame Grenze: `postEntries`, `reverseSource`, `reverseTransaction` verweigern auf PC2 (`CLIENT_HAS_NO_BOOKS`, zählt für `watchLedgerPosts`) — damit jede `post*`-Funktion, jede Nachbuchung, der Ledger-Prüfstand und der Orphan-Storno. Dazu prüfen SettingsPage, BackfillPage, LedgerDebugPage, RepairFlowTestPage und RepairReconcilePage selbst, wo sie laufen (auf PC2 wird kein Handler eingehängt); Riegel in `withBranch`/`runAll` (Nachbuchung), `runAll`/`handlePurge` (Prüfstand), im Orphan-Storno und im Schreibhelfer `setSetting` (`blockPrimaryOnlyOnClient` / `assertPrimaryOnly`). Keine neue Fernfähigkeit. | `test/r7b` §4; Zwei-Rechner-Lauf: jede Fläche sagt auf PC2 „Only available on the main computer" |
| PP-7 | Toter Alt-Code. | Entfernt: der InvoiceDetail-`editing`-Zweig samt „Edit Lines"-Kette (nie betreten; Bearbeiten = InvoiceCreate); der alte Client-Bereich `src/components/client/` (14 Dateien) — nur erreichbar mit einem Ausweis ohne Sitzung, und diesen Zustand gibt es seit PP-5 nicht mehr; `ClientShell` = nur noch Anmeldung. Dadurch verwaist und ebenfalls entfernt: `client-commercial-request`, `client-invoice-save`, `client-lifecycle-request`, `client-masterdata-draft`, `client-service-request`, `invoice-form-source`, `invoice-request` (kein Import, keine Registrierung, kein IPC/Route/Migration). `resetPrimarySource` war nicht tot, sondern unverdrahtet — jetzt am Abmelden auf PC2. Die Tests prüfen die lebenden Parser/Handler mit wörtlichen Rümpfen. Historische E2E-Skripte der alten Oberfläche (`client-*.e2e.mjs`, alte `c5`/`c6`-Selektoren) laufen im Sweep nicht mit und bleiben unverändert. | `test/r7b` §5; Typcheck grün; Registry 175 |
| PP-12 | Jeder Fernbefehl wartete fest 20 s (`DEFAULT_TIMEOUT`), auch das größte Dokument (25 116 672 B) und die Texterkennung; die Oberfläche sagte „No answer from the primary", obwohl er noch arbeiten konnte; eine nicht geladene Vorschau blieb stumm leer. | `bridge::timeout_for(op, payload)`: alles Normale bleibt 20 s; `documents.upload` 20 s + Länge × 10 Durchgänge / 10 MB/s (größte Datei 53,5 s), `documents.content.get` 20 s + 32 MiB × 4 / 10 MB/s (33,4 s), `documents.set_ocr` 20 s + 10 s Start + 12 MP / 0,2 MP/s (90 s). Abgeleitet aus dem Vertrag des Hauses (Zeile ≤ 32 MiB) und der neuen Bildpunktgrenze der Erkennung (`OCR_MAX_PIXELS` = 12 MP; größere Bilder werden vorher maßstabsgleich verkleinert). Frist ≠ Erfolg (504 `unknown`), Wiederholung mit derselben Kennung, genau eine Wirkung. Oberfläche: „läuft seit N s" (Upload, Erkennung), Frist-Text „may still be working … press again", Vorschau-Fehler mit „Try again". | Rust `bridge_tests` (Fristen, Klammer, TS == Rust); `test/r7b` §6; Zwei-Rechner-Lauf PP-12 |

**Zwei-Rechner-Lauf** `test/e2e/r7b-platform-hardening.e2e.mjs` **44/0** (frische E2E-Programme; nur die echten Laufzeitpunkte, kein
historischer Sweep): Primary ohne Schlüssel → „AI Identify" auf PC2 vor dem Klick gesperrt mit Grund; mit Schlüssel erkennt PC2
über den Primary (Mock-KI des e2e-Builds bekam genau EINE Anfrage mit dem Schlüssel des Primary, PC2 fragte nie OpenAI, auf PC2 kein
Schlüssel — auch ein alter eigener wird nicht benutzt; kein Preis/Menge/SKU übernommen); Nachricht, Preis und `/ai` auf PC2 gesperrt;
sieben Maschinenflächen sagen es auf PC2; das größte Dokument (25 116 672 B) über PC2 bytegenau in **20,0 s** (Frist 53,5 s;
Oberflächenmessung Klick → Maske zu, eine Probe, Abfrageraster 0,2 s, enthält Dateilesen auf PC2 und Listen-Neuladen), zurück in die
Vorschau in **5,0 s** (Frist 33,4 s), Erkennung an einem 24-MP-Bild in **15,0 s** (Frist 90 s), „läuft seit N s" sichtbar, keine Frist
gerissen; Primary-Start mit der Sitzung eines fremden Rechners →
Anmeldung verlangt, A meldet sich neu an, der Server lief weiter; PC2 abmelden/anmelden, unbrauchbarer Ausweis, Trennen
(Erstlauf-Weiche, kein Kontrollzustand, keine Datei) und neu verbinden. PC2 ohne lokale Datenbank, alte `lataif.db` unberührt,
Produktions-App, `E:\LATAIF\Data` und Ports 3001/3443 unberührt (`POST_PARITY_R7B_TWO_APP_PROVED`).
Prüfstandsbefund: Der Aufbau beendete den Primary nach dem Onboarding ~1,2 s nach `flush_database_now` HART
(`killTestImage` → `taskkill /F /T /PID`); die Sekunden alte Anmeldung (`localStorage`) war danach weg — WebView2 schreibt den
Seitenspeicher verzögert, ein hartes Beenden verwirft das Ungeschriebene. Änderung im R7B-Lauf: **eine bloße feste Wartezeit** von
6,5 s vor dem harten Beenden (kein Zustandsnachweis). Reguläres Beenden ist nicht betroffen — bewiesen im Review-Lauf unten
(Fenster schließen → Close-Orchestrierung → `AppHandle::exit`, OHNE Wartezeit, Anmeldung und frischer Eintrag überleben).

**Review-Nachweis** `test/e2e/r7b-review-runtime.e2e.mjs` **20/0** (dieselben Programme, nur der Primary):
- **Reguläres Beenden:** direkt nach dem Onboarding bzw. direkt nach einem frischen `localStorage`-Eintrag das Fenster geschlossen
  (WM_CLOSE an die eigene PID am exakten Test-Pfad) — der nächste Start ist angemeldet, der Eintrag ist da
  (`POST_PARITY_R7B_REVIEW_REGULAR_CLOSE_KEEPS_STORAGE_PROVED`).
- **PP-4 in der echten Anwendung:** Dauerauftrag über den echten Fernbefehl; die Uhr der Seite per Test-Skript auf 30.09. 23:59:15;
  ohne Klick, ohne Neuladen, ohne Ausgabenliste entstand der Oktober **18,6 s** nach Mitternacht der Seite (Taktgeber, 60-s-Takt)
  genau einmal, ein weiterer Takt legte nichts nach; nach regulärem Neustart (Uhr 02.12.) November und Dezember nachgeholt, jeder
  Monat genau einmal (`POST_PARITY_R7B_REVIEW_PP4_RUNTIME_PROVED`).
- **PP-12 am Befehlsweg** (`/api/command`, Zeit am Aufrufer, Loopback, `performance.now`, je eine Probe): das größte Dokument
  dreimal nacheinander **17,9 s / 23,0 s / 31,3 s** bei einer Datenbank von danach 69 / 136 / 203 MB (Frist 53,5 s); Inhalt zurück
  4,6 s (Frist 33,4 s); Erkennung 24 MP 22,6 s (Frist 90 s, danach DB 203 MB).
  **Befund:** die Upload-Zeit wächst mit der Datenbankgröße (jede Buchung speichert durabel die GANZE Datei: Export + Schreiben).
  Die abgeleitete Frist rechnet nur die Nutzlast; der Abstand fiel von 3,0× auf 1,7×. Mit weiter wachsender Datenbank kann auch die
  neue Frist erreicht werden — PP-12 ist deshalb nur **teilweise** geschlossen (fehlt: DB-Größen-Anteil in der Frist, z. B. aus der
  Dateigröße von `lataif.db` am Primary, oder Belege außerhalb der Hauptdatei). Zur alten 20-s-Grenze trägt die Messung nur: bei
  136 und 203 MB lag der gesamte Rundlauf mit 23,0 und 31,3 s über 20 s — die alte Frist (sie misst nur das Warten ab Übergabe an das
  Fenster) wäre dort sehr wahrscheinlich gerissen; bei 69 MB (17,9 s) nicht. **[Korrektur 15.09.2026: „ab Übergabe an das Fenster"
  schließt die Wartezeit in der Schreibreihenfolge des Primary ein — sie zählt gegen die Frist; `docs/r7b-pp12-image-paths-review.md` § 5.]**

**Einheitstests:** `test/r7b/r7b-platform-hardening.test.ts` **111/0**; direkte Nachbarn (48 Dateien, u. a. client-read-mode,
r3/r4b/r4c-Matrix, c4, c6, r6b–r6f-Gates, payables, office, gold, pp13, r7a, remote-invoice-create, service-parity) grün; Rust
`bridge_tests`/`ai_route_tests`/`w4` **64/0**; Typcheck grün; Lint ohne neue Fehler (InvoiceDetail −1).

```
PP offen vorher: 6
R7B Scope:       6
geschlossen:     5  (PP-3, PP-4, PP-5, PP-6, PP-7)
teilweise:       1  (PP-12 — Frist ohne DB-Größen-Anteil, Review-Befund)
verbleibend:     1  (PP-12, Rest)
Registry 175 → 175
Version 0.8.54 · kein Release
```

## R7B / PP-12 — Bildwege und Frist nach der echten Speicherung (15.09.2026)

Bestandsaufnahme aller produktiv erreichbaren Bild-Uploads (Handy, Primary, PC2) mit Callpath, Grenzen, Speicherort,
Fristen und Vorher/Nachher: `docs/r7b-pp12-image-paths-review.md`. Keine neue Fernbuchung, Registry unverändert **175**.

| Punkt | Behebung | Beweis |
|---|---|---|
| PP-12 (Rest) | `bridge::timeout_for(op, payload, db_bytes)`; `db_bytes` = Größe von `lataif.db` am Primary (`command_execute`). `documents.upload` + (DB + 2 × Länge) / 4 MB/s (Dokumentzeile + Abgleich-Zeile), `documents.set_ocr` + DB / 4 MB/s; `documents.content.get` (liest nur) und alle normalen Befehle unverändert. Frist ≠ Erfolg (504 `unknown`), dieselbe Kennung wartet in der Schreibreihenfolge und bekommt das eingefrorene Ergebnis. | Rust `bridge_tests` (`the_writing_document_paths_grow_with_the_database`); `test/r7b/pp12-images` §4; `test/e2e/r7b-pp12-large-db` **13/0**: größtes Dokument 17,8 s / 21,9 s / 27,8 s bei 2 / 203 / 451 MB gegen Frist 70,6 / 121,0 / 182,9 s, Texterkennung bis 518 MB, jede Wirkung genau einmal |
| Bildwege | EIN Normalisierer für Belegbilder (Reparatur, Altgold, Ausweisfoto, Einkauf/Auftrag „New Item", Sonderstück-Entwurf): `media::record_image` = `normalize_stock_image` des Medienspeichers (JPEG ≤ 100 000 B, ≤ 1600 px, EXIF-Ausrichtung, Metadaten weg; ein Foto in gespeicherter Form bleibt Byte für Byte). Gerechnet am aufnehmenden Rechner — Primary vor der Klammer, PC2 vor dem Ablegen (`stageRecordDataUrls`); der Primary prüft beim Abholen (`staging_media_read_record`). Gespeicherte Fotos werden nie umgerechnet. Artikel, Kommission, Fertigung bleiben im Medienspeicher (Hauptbild ≤ 100 000 B + Vorschau ≤ 20 000 B). | `cargo test media::record_image` 6/0; `test/r7b/pp12-images` **56/0**; `test/e2e/r7b-pp12-images` Bildteil **22/0** (Primary-Maske, PC2-Transport, Wiederholung, Ersetzen, Anzeige Primary + PC2, regulärer Neustart) |
| Aufnahme | Profil an einer Stelle (`capture-profile.ts`), bewusst 800 px / 0,7 (Handy 1600 / 0,85): gemessen kostet eine 1600-px-Aufnahme im Normalisierer ~1,6 s je Foto innerhalb der 20-s-Frist eines PC2-Artikels. Unlesbare Datei wird übersprungen und genannt, Transparenz auf Weiß. | `test/r7b/pp12-images` §1; Release-Bench `record_image` |

Offen, nicht Teil von PP-12 (zur Entscheidung, Einzelheiten im Review): Handy-Reparatur-/Inbox-Fotos über den Abgleich-Push ohne
Byte-Grenze; Artikelbilder aus Einkauf/Auftrag weiter in `products.images` statt Medienspeicher; normale Befehle bei großer
Datenbank (10,7 s bei 451 MB, mit belegter Schlange über 20 s); die Frist enthält keine Wartezeit hinter anderen Aufträgen **[Korrektur 15.09.2026: gemeint ist „die Formel hat
dafür keinen Anteil" — die Wartezeit zählt gegen die Frist und verlängert sie nicht; Review § 5]**;
`plugin-fs writeFile` ohne fsync; Handy-Drain-Lease ohne Verlängerung; nach WM_CLOSE endete der Primary bei ≥ ~340 MB nicht.

```
PP offen vorher: 1  (PP-12, Rest)
geschlossen:     1  (PP-12)
verbleibend:     0  (Post-Parity-Backlog PP-1 … PP-14: alle geschlossen, lokal — unabhängige Prüfung offen)
Registry 175 → 175
Version 0.8.54 · kein Release
```

## R7B / PP-12 — Abschlussprüfung: Beenden, Handy-Übernahme, Artikelbilder (15.09.2026, Nachtrag)

Unabhängige Prüfung von `0a15565`, zuletzt des Quellstands `fca07b1` — **technisch freigegeben**
(`R7B_TECHNICAL_REVIEW_APPROVED_FCA07B1`; nicht gepusht, nicht released; R1–R4, G5 offen, Review § 0/§ 14): Befunde einzeln nachgewiesen und — wo Pflicht — behoben. PP-3 … PP-7 nicht
angefasst. Review mit Callpaths, Messungen und Baseline: `docs/r7b-pp12-image-paths-review.md`. Keine neue Fernbuchung, Registry
unverändert **175**.

| Punkt | Status | Beweis |
|---|---|---|
| PP-12 Frist der Dokumentwege | geschlossen (unverändert seit `1479b09`) | `r7b-pp12-large-db` 13/0 |
| Reguläres Beenden bei großer DB (F4) | **behoben** — wartender Schritt: `waitForSyncIdle` mit fester 8-s-Frist, während der Selbst-Abgleich des Primary die ganze DB zweimal speichert; vorbestehend (Baseline `d988810` hängt identisch). Die Wartefristen (Abgleich, Flush) rechnen jetzt 2 × Datei / 4 MB/s dazu, an jedem Wartepunkt (Schließen, Neuladen, Backup, GC, Restore, Updater, Datenort) | `pp12-close-budget` 19/0; `r7b-pp12-shutdown` **14/0** (518 MB, Abgleich unterwegs: endet regulär nach 23,9 s; Neustart vollständig) |
| Handy-Reparatur / Einkaufs-Inbox (G2) | **behoben** — die Grenze fehlte an jeder Stelle (Handy → `/api/sync/push` → Übernahme); jetzt bei der Übernahme jedes neue Foto jeder Bildspalte durch den EINEN Normalisierer, gespeicherte unverändert, Umweg → Quarantäne | `pp12-pulled-images` 26/0; `r7b-pp12-mobile-takeover` **20/0** (Handyfoto 474 184 B → 89 841 B 982×655, Inbox 475 075 B → 90 475 B; Umweg → 2 Quarantänefälle; Ergänzen: gespeichertes Byte für Byte; Anzeige Primary + PC2; Neustart) |
| „New Item"-Artikel in `products.images` (G3) | **zusammengeführt** — Cutover-Dienst nach dem Commit: Hauptbild ≤ 100 000 B + Vorschau ≤ 20 000 B im Medienspeicher; übrige Schreiber begründet | `pp12-new-item-media` 17/0; Mobile-Lauf (Einkauf 95 406 B + Vorschau 16 731 B, Auftrag 81 447 B + 19 273 B, Spalte leer auch nach Echo und Neustart); `r7b-pp12-images` **22/0** |
| Aufnahmeprofil 800 / 1600 px (G7) | gemessen begründet auf Release-Messung (Artikelweg 8 Aufnahmen + Belegweg; Bytes Debug = Release); ursprünglicher 504 als Debug-Artefakt erklärt; kein neues Profil | Review § 4; Release-Bench `bench_capture_profile` |
| Timeout / Wiederholung derselben Kennung (G6) | belegt am Callpath: während des ersten Laufs, nach 504, nach Commit bei verlorener Antwort, nach Neustart → genau eine Wirkung (Replay); keine neue Ergebnis-API nötig | Review § 5; Rust `bridge_tests`, `write-foundation`, `remote-invoice-create`, E2E CONC-MONEY / LOST |
| Handy-Drain-Lease (F2) | belegt: 120 s je Auftrag, Token-Besitz; Ablauf während der Übernahme → alter Besitzer `ready_rejected`, ein Produkt, nichts verloren. Korrektur: Ablauf allein lehnt nichts ab (nur eine Übernahme durch einen anderen Claimer) | Review § 5a; `drain-handoff` §20 **106/0** |
| Persistenz (F1) | **korrigiert (Review `19ac2da`)**: regulärer Neustart durch die vorhandenen Neustart-Nachweise belegt; Stromausfall-Dauerhaftigkeit nach der Speicherbestätigung **nicht garantiert**; eine feste zeitliche Obergrenze des Risikofensters ist nicht belegt (die Fassung „fest nach einigen Sekunden" ist als unbelegt zurückgenommen); vorbestehend seit `88e1199`, nicht geändert (kein Speicherumbau) | Review § 6; Diagnose sql.js |
| PP-5 Sitzungsablauf (Review `19ac2da`) | **behoben**: `verifyStoredSession` prüft `sessions.expires_at` der eigenen DB (abgelaufen / unlesbar / leer → verworfen); scheitert die Prüfung, wird die Sitzung verworfen — auch der Fang in `App.tsx` (vorher nur protokolliert) | Review § 13.1; `r7b-platform-hardening` **118/0** |
| PP-12 ungültige Bildformen (Review `19ac2da`) | **behoben**: dahinter prüft die Übernahme nur die Transportform (belegt); gemischte Liste, Objekt statt Liste, Nicht-Text bei `cpr_image`, Entwurf ohne gültige Fotoliste → Quarantäne `RECORD_IMAGE_SHAPE_INVALID`; leere Felder und unveränderte Bestandswerte bleiben | Review § 13.2; `pp12-pulled-images` **32/0** |
| Meldung bei offenem Ausgang (Review `19ac2da`) | **korrigiert**: kein absolutes „it can never happen twice"; die Wiederholung gilt aus derselben Maske, nach Verlassen/Neuladen erst nachsehen (R1 bleibt offen) | Review § 13.4 |
| Normale Befehle bei großer DB (G5) | Skalierungsbefund, offen | Review § 8 |
| Restbefunde R1–R4 (bestätigt, vorbestehend, offen) | R1 offene Kennung nur im Speicher der PC2-Maske (Maske verlassen nach „keine Antwort" → zweite Wirkung möglich); R2 geändertes Formular nach „keine Antwort" → wiederholter Konflikt; R3 Konflikt nach Verdrängung/Neustart als 500 „unbekannt"; R4 0-Byte-`lataif.db` startet leer statt `DB_RECOVERY_REQUIRED` | Review § 0, § 5, § 6 |
| Rust `legacy_push … o1_o5_o10` | **behoben** (52/36/37 aus dem Manifest; rot seit `ab7f169`) | `cargo test sync::routes` 74/0 |

```
PP offen vorher:     0  (Post-Parity-Backlog PP-1 … PP-14 geschlossen)
Prüfbefunde:         F4 behoben · G2 behoben · G3 zusammengeführt · Rust-Pin behoben ·
                     G7/G6/F2/F1 belegt eingeordnet · Review 19ac2da: PP-5-Ablauf, PP-12-Formen, Meldung behoben ·
                     offen (separat, nicht akzeptiert): R1–R4, G5 (eigene Entscheidung)
verbleibend PP:      0
Freigabe:            technisch freigegeben R7B_TECHNICAL_REVIEW_APPROVED_FCA07B1 (geprüft: fca07b1e33929f972d7c66c8ca22789f8f7ab3bc)
                     · lokal committed ja · gepusht nein · released nein
                     [Nachtrag: gepusht ja — `d988810..1635c8a` am 15.09.2026, nach Freigabe + PP-5-Randfall]
offen, nicht akzeptiert: R1, R2, R3, R4, G5   [R1–R4 → Abschnitt R7C unten]
Registry 175 → 175
Version 0.8.54 · kein Release
```

## R7C — offene PC2-Speichervorgänge (R1–R3) und Datenbank-Startschutz (R4) (15.09.2026)

Folgeauftrag zu den offenen R7B-Restbefunden. Review mit Callpaths, Lösung je Befund, Nachweisen und Grenzen:
`docs/r7c-pending-saves-review.md`. Keine neue Fernbuchung, Registry unverändert **175**, Version 0.8.54.

| Befund | Behebung | umgesetzt | getestet (lokal) | unabhängig freigegeben |
|---|---|---|---|---|
| R1 offene Kennung nur im Maskenspeicher | Jeder Versuch wird VOR dem ersten Versand gesichert (`pending-saves`: eine Datei je Vorgang unter AppLocalData, Kennung + ursprünglicher Auftrag + Kontext; scheitert das, geht nichts hinaus). Wiederaufnahme mit derselben Kennung nur im selben Primary/Mandant/Benutzer/Filiale über die Leiste „Unresolved saves" (Replay über den durablen Nachweis, keine zweite Wahrheit); neue Kennung neben einem offenen Vorgang derselben Buchung nur ausdrücklich (zweiter Klick); mehrere offene Vorgänge unabhängig; fehlende Staging-Bilder → begründetes Nein | ja (`2b98e46`) | ja — `test/r7c/pending-saves` **56/0**; E2E S1/S3 (Wiederaufnahme nach Primary-Neustart (regulär) und PC2-Neustart, Replay, genau ein Kunde) — **Korrektur:** in Lauf 2 wurde PC2 wegen N1 NICHT regulär beendet, sondern hart über den Test-Helfer (`killTestPid`, eigene PID); reguläres Beenden von PC2 erst mit dem N1-Nachweis unten | **ja** — unabhängig technisch freigegeben (Auftrag N1, 15.09.2026) |
| R2 geändertes Formular → Dauer-Konflikt | Ursprünglicher Auftrag und Formularänderung getrennt: die Änderung geht unter der offenen Kennung nicht hinaus (`ORIGINAL_UNRESOLVED`, nichts gesendet), Weg: erst klären, dann ändern oder neu erfassen | ja (`2b98e46`) | ja — Einheit; E2E S2 (nichts gesendet) | **ja** (s. R1) |
| R3 Konflikt nach Verdrängung/Neustart als 500 „unbekannt" | Renderer `Reply` `not_executed` → Rust `Reply::NotExecuted` → 409 `outcome: not_executed` wie der Brücken-Konflikt; eine vom Nachweis abgewiesene Anfrage bleibt nicht als Besitzer im Kennungsspeicher (sonst 409 für den ursprünglichen Auftrag — E2E-Fund, `8f37ee5`); Konflikt hält den Vorgang offen; `not_executed` nach einem offenen Versand bleibt offen (`EARLIER_TRY_OPEN`) | ja (`2b98e46`, `8f37ee5`) | ja — Einheit, `cargo test command_reply` 2/0, `bridge` 44/0, `sync::routes` 76/0; E2E S4 (409 `not_executed`, danach Replay) | **ja** (s. R1) |
| R4 0-Byte-`lataif.db` startet leer | `loadDbFile`: 0 Byte → unlesbar → `DB_RECOVERY_REQUIRED` vor Schema/Migration/Speichern, Datei unverändert; „fehlt" nur bei ausdrücklichem „nicht gefunden" (Lesefehler ≠ fehlend) | ja (`c4098a8`) | ja — c6 **27/0**; E2E S5 (Wiederherstellungsmeldung, Datei unverändert, Bytes zurück → normaler Start) | **ja** (s. R1) |
| G5 Ganz-DB-Speichern skaliert | — | nein | — | **OPEN, nicht akzeptiert** |
| N1 (neu, vorbestehend) PC2 lässt sich über das Fenster nicht regulär beenden | `finalize_application_shutdown` verlangte `State<AppHandleState>`, den nur ein Start mit Datenwurzel verwaltet (PC2 läuft im Erstlauf-Zweig: keine Brücke, kein Server, keine DB) → „state not managed … The app stays open". Jetzt nur `AppHandle`; Server über `try_state` gestoppt, WENN vorhanden, dann `exit(0)` — kein Ersatzzustand, Primary-Pfad unverändert | ja (Folgecommit N1) | ja — Rust neuer Test + `shutdown_tests` 5/0; gezielter Zwei-App-Lauf S3 **21/0**: PC2 endet nach WM_CLOSE von selbst (Exit-Code 0, 2 s, kein Helfer), Datei Byte für Byte erhalten, weiter B, Replay genau einmal, keine DB auf PC2 | **nein** |
| N2 (neu, vorbestehend seit `02c976b`) Rust-Gate `every_command_is_either_root_bound_or_named_as_first_run_safe` rot | `media_normalize_record_image` (R7B PP-12) keiner Klasse zugeordnet; beim N1-Testlauf gefunden, nicht geändert | nein | belegt (Testausgabe) | **OPEN, nicht akzeptiert** |

E2E `test/e2e/r7c-pending-saves.e2e.mjs`: Lauf 1 (Build `2b98e46`) 27/2 → Fund Rust-Kennungsspeicher, behoben `8f37ee5`;
Lauf 2 (Build `8f37ee5`) **28/1**, alle R1–R4-Prüfungen ja, der eine Fehler ist N1 — **Korrektur:** in Lauf 1 und 2 wurde PC2
in S3 hart über den Test-Helfer beendet, nicht regulär; „regulär" galt dort nur für den Primary. N1-Nachweis (gezielt S3, frische
Builds aus dem N1-Stand): **21/0**, PC2 regulär beendet (Exit-Code 0, kein Helfer). Review § 6a.

```
R7C:                 R1, R2, R3, R4 umgesetzt + lokal getestet · unabhängig technisch freigegeben (laut Auftrag)
N1:                  umgesetzt + lokal getestet · unabhängige Freigabe ausstehend
offen, nicht akzeptiert: G5, N2
Registry 175 → 175
Version 0.8.54 · kein Push/Tag/Release
```
