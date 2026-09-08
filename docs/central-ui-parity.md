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
