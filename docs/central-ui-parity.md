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

