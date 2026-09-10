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

