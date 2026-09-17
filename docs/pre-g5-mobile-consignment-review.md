# PRE-G5 — Kommission vom Telefon (Mobile Consignment)

Stand 16.09.2026 · Basis `1d97cf9` · Version 0.8.54 · Registry **175 → 175** · kein Push/Tag/Release.

## 0. Scope-Audit am echten Code

Die Handy-Seite kannte Kommissionen bisher **gar nicht**: `mobile_page.rs` hat drei Betriebsarten
(Collection-Foto, Repair, Purchase-Foto). Es gibt also nichts abzulösen — nur eine Oberfläche für
einen Weg, den der Primary längst hat.

Was der Rechner anbietet, welche Domänenfunktion es tut, welcher Fernbefehl schon da ist, und ob es
auf ein Telefon gehört:

| Aktion am Rechner (Ort) | Domänenfunktion | vorhandener Fernbefehl | mobil |
|---|---|---|---|
| Kommission anlegen (`ConsignmentList` → „New") — legt **Artikel und Kommission in EINER Transaktion** an | `createConsignmentWithProduct` / `createConsignmentOnPrimary` | **ja** `consignments.create` | **ja** |
| Duplikatsfrage vor dem Anlegen | `findPossibleDuplicates` (Haus), `duplicate-dismiss` (Bildschirmhilfen) | im Rumpf: `acknowledgeDuplicate` | **ja** — fragen und „Create anyway" |
| „Copy details" aus dem Duplikatsdialog | `findPossibleDuplicates` + `copiedAttributes` (beide am Primary) | **ja, neu**: die Auskunft `products.duplicates.get` — sie fragt dieselbe Erkennung und gibt genau die Felder heraus, die „Copy details" übernimmt | **ja** |
| „Pick existing" aus dem Duplikatsdialog | Navigation zur Artikelseite — es wird nichts geschrieben | — | **nein** — reine Bildschirmnavigation des Rechners |
| Kopf ändern (vereinbarter Preis, Mindestpreis, Ablauf, Notiz) | `updateConsignment` | **ja** `consignments.update` | **ja** |
| Auszahlungsmodell ändern (`percent` / `consignor_fixed` / `cost_split`) | `buildPayoutPatch` + `updateConsignmentPayoutModel`, Sperre `payoutModelLock` (+ dieselbe Bedingung als SQL **im** UPDATE) | **ja** `consignments.update` (`payout`) | **ja**, aber nur wenn der Primary es erlaubt (`payoutLocked` der Auskunft) |
| Verkauf erfassen | `recordConsignmentSaleInHouse` (Einkauf beim Einlieferer, Rechnung, ggf. Verlust, Status) | **ja** `consignments.record_sale` | **ja** |
| Auszahlung an den Einlieferer | `payOutConsignmentInHouse` | **ja** `consignments.record_payout` | **ja** |
| Unverkauft zurückgeben | `markReturned` (Haus) | **ja** `consignments.mark_returned` | **ja** |
| Post-Sale Return (nach dem Verkauf zurück) | `returnConsignmentAfterSaleInHouse` | ja `consignments.return_after_sale` | **nein** — Korrektur eines **gebuchten** Verkaufs mit Warenweg, Erstattungsweg und Grund (Retourenhaus, Rechnungsgrundlage, Einkaufsstorno); dieselbe Linie wie `repairs.update_line` und das Löschen: was am Schreibtisch entschieden wird, bietet das Telefon nicht an |
| Cancel Sale (Verkauf stornieren) | `cancelConsignmentSaleInHouse` | ja `consignments.cancel_sale` | **nein** — Storno samt Retourenstorno, der die **Owner**-Regel verlangt |
| Bilder des Artikels | Medienspeicher; Galerie über `products.update` (`{keep}`/`{stagingId}`) | **ja** `products.update` | **ja** — beim Anlegen als `stagingIds`, beim Bearbeiten als Galerieplan |
| Kommission löschen | — (es gibt keinen Knopf) | — | **nein** |

**Felder, die die Maske des Rechners erfasst** (und die das Telefon deshalb auch erfasst):
Einlieferer · Artikel (Kategorie, Marke, Modell/Name, Zustand, Merkmale der Kategorie,
Lieferumfang, SKU getippt oder vom Zähler, Notiz) · vereinbarter Preis · Mindestpreis ·
Auszahlungsmodell samt Parameter · Ablaufdatum · Notiz · Bilder.
Was der Primary **fest** setzt und kein Rumpf tragen darf: Einstand 0, Menge 1,
`stockStatus: 'consignment'`, `sourceType: 'CONSIGNMENT'`, Kommissionsnummer, SKU-Vergabe,
Provision, Auszahlungsbetrag, Status, Fassung.

**Ergebnis:** für Mobile fehlt **keine** Domänenlogik und **keine** Operation — es fehlt nur die
Oberfläche. `PRE_G5_CONSIGNMENT_SCOPE_PROVED`


## 1. Der Weg — unverändert der von PC2

```
Telefon (JWT)  →  POST /api/staging/media   (Fotos zuerst, Kennung = Hash der Bytes)
               →  POST /api/command {op, commandId, payload}
               →  routes.rs command_execute → Brücke → Renderer des Primary
               →  runRemoteCommand (eine Transaktion + durabler Nachweis)
               →  createConsignmentWithProduct / updateConsignment / recordConsignmentSaleInHouse /
                  payOutConsignmentInHouse / markReturned / products.update
               →  authoritative DB
```

Mandant, Filiale, Benutzer und Rolle kommen ausschließlich aus dem geprüften Token. Nummer, SKU,
Provision, Auszahlungsbetrag, Status, Bestand und jede Buchung rechnet der Primary.

Neue Dateien (alle wörtlich in die Handy-Seite eingebettet):
- `src-tauri/src/sync/mobile_consignment_commands.js` — Rumpfbau ohne DOM, in node prüfbar.
- `src-tauri/src/sync/mobile_consignment_ui.js` — die Oberfläche.
- `src-tauri/src/sync/mobile_consignment.html` — das Markup.

**Wiederverwendet statt nachgebaut:** der durable Auftraggeber (`MobileRepair.createClient` —
Kennung, Ablage, Wiederholung, Klärung), das Feldschema der Kategorien samt
`makeControl`/`readAttr`/`dependsSatisfied`/`applyDependencies` (SSOT `field-contract.ts`), der
AI-Übernehmer `aiApplyToForm` und der Medienweg. An `mobile_page.rs` wurden genau zwei Helfer
parametrisiert: der Zeilen-Prefix der Abhängigkeiten (dritter Feldsatz) und die Zielfelder des
AI-Übernehmers; ohne Angabe verhalten sich beide Zeichen für Zeichen wie vorher.

## 2. Oberfläche

Übersicht (`consignHome`): Suche über `consignments.list`, Liste, „New Consignment Intake", Leiste
**„Unresolved saves"**.
Maske (`formConsign`): Einlieferer wählen oder anlegen · bis zu **8 Fotos** (Kamera/Galerie, erstes
antippen = nach vorn) · Kategorie mit **ihren** Pflichtfeldern und Merkmalen aus dem Feldschema ·
Marke, Modell, Zustand, Lieferumfang, Referenz/SKU · vereinbarter Preis, Mindestpreis,
Auszahlungsmodell samt Parameter, Ablaufdatum, Notiz · „AI Identify".
An einer **bestehenden** Kommission: Zustand (Status, Modell, Verkauf, Auszahlung offen/bezahlt),
Galerie ändern („Save photo changes"), Verkauf erfassen, Auszahlung, Rücknahme. Die Ware selbst
(Kategorie, Merkmale) ändert der Rechner — wie dort auch.

## 3. AI

Derselbe Weg wie im Anlegeformular des Telefons: `/api/ai/identify` in der **Produktform** mit der
gewählten Kategorie. Es gibt keine zweite Pipeline und keine neue Vertragsform. Übernommen wird
über `aiApplyToForm` — nur in **leere** Felder, nur Marke, Modell, Zustand und die Merkmale der
gewählten Kategorie. Preis, Auszahlungsmodell, Einlieferer, SKU und Nummern kann sie nicht
bestimmen; gespeichert wird nichts, jede Übernahme ist sichtbar („Filled N empty fields").

## 4. Domäne und Auszahlungsverträge

- **Anlegen ist EIN Vorgang:** `consignments.create` fährt `createConsignmentWithProduct` —
  Artikel (über den Medienweg) **und** Kommission in einer Transaktion. Scheitert etwas, bleibt
  nichts stehen.
- **Duplikatserkennung:** der Primary fragt (`POSSIBLE_DUPLICATE`), das Telefon zeigt seine
  Nennung und bietet „Create anyway" an — das ist ein **eigener** Auftrag mit **eigener** Kennung.
  Vorsorglich bestätigt wird nie.
- **Auszahlungsmodelle:** `percent` (Satz 0–100), `consignor_fixed` (kein Parameter),
  `cost_split` (Shop-Anteil 1–99). Der Rumpf trägt **nur** die Parameter des gewählten Modells;
  gebaut wird der Patch am Primary (`buildPayoutPatch`).
- **Historische Bindung:** das Modell ist gesperrt, sobald daraus Zahlen wurden (Verkauf, Rechnung,
  Provision/Auszahlung, Teilauszahlung, Status). Die Sperre kommt als `payoutLocked` aus
  `payoutModelLock` **des Primary** in die Auskunft; das Telefon zeigt sie und lässt das Modell
  nicht mitreisen. Ein Erzwingen ist damit nicht möglich — und selbst dann entscheidet die
  `PAYOUT_EDITABLE_SQL`-Bedingung **im** UPDATE.
- **Verkauf unter dem Boden:** das Telefon rechnet **nicht** nach. Erst das `SALE_BELOW_FLOOR` des
  Primary macht die Frage sichtbar; die Bestätigung ist ein eigener Auftrag mit eigener Kennung.
- **Ownership/Herkunft/Bestand/Nummern:** Einstand 0, Menge 1, `stockStatus: 'consignment'`,
  `sourceType: 'CONSIGNMENT'`, SKU und Kommissionsnummer setzt der Primary — der Rumpf trägt sie
  nicht einmal. `PRE_G5_CONSIGNMENT_DOMAIN_PROVED`

## 4b. „Copy details" — Feldmenge und Bedeutung des Rechners

Der Rechner ist die SSOT (`ConsignmentList`, `onCopyDetails`). Das Telefon übernimmt jedes Feld,
das er übernimmt UND das der Vertrag einer Kommission trägt (`CONSIGNMENT_PRODUCT_FIELDS`):
Kategorie, Marke, Modell, Zustand, **Steuerart**, **Artikel-Notiz**, Merkmale und Lieferumfang.
Die Merkmale kommen bereits gefiltert vom Primary (`copiedAttributes`): die **Referenznummer wird
übernommen** — wie am Rechner —, die **Seriennummer nie**, und die **SKU nie** (sie gehört dem
neuen Stück). **Bilder nur in ein leeres Ziel**: hängt schon ein eigenes Foto an der Maske,
bleiben die Bilder des Treffers außen; sonst holt das Telefon sie über die angemeldete
Medienroute und behandelt sie wie eigene Aufnahmen — Wort für Wort die Regel des Rechners.
**Die drei Verkaufspreise bleiben außen vor**, und zwar nicht aus Bequemlichkeit: der Vertrag
einer Kommission trägt sie nicht, ein Feld dafür wäre eine Sackgasse. Der Einstand einer
Kommission ist ohnehin der Erwartungswert des Hauses.

Die Auskunft selbst ist **fail-closed**: sie nimmt genau `categoryId, brand, name, sku, attributes`,
jeder andere Schlüssel wird mit `UNKNOWN_FIELD` abgewiesen statt still übergangen.

## 5. Bilder

Dieselbe Infrastruktur wie PC2: Ablage über `/api/staging/media` (Kennung = SHA-256 der Bytes, der
Server rechnet sie), Auflösung **innerhalb** des Befehls, Bytes reisen nie in einem Auftrag.
Beim Anlegen `stagingIds`; beim Ändern der Galerieplan von `products.update`
(`{keep:<mediaId>}` / `{stagingId}`) — behaltene Bilder nennen ihre **Identität**, nicht eine
Stelle. Gespeicherte Bilder holt der Browser über die angemeldete Route `/api/media?key=`.
Dasselbe Foto zweimal hochgeladen ergibt dieselbe Kennung, also kein zweites Bild; scheitert das
Anlegen, entsteht weder Artikel noch Kommission noch Bildverknüpfung (verwaiste Dateien räumt die
Medien-Müllabfuhr). Kein eigener Mobile-Medienpfad.

## 6. PC2-Kompatibilität

Ein Datensatz, drei Oberflächen: das Telefon benutzt **dieselben** Operationen wie PC2, mit
denselben Rumpffeldern, und der Primary fährt darunter **dieselbe** Hausfolge wie seine eigene
Maske. Belegt im Browserlauf: eine Änderung, die von einem anderen Rechner kommt (neuer Preis,
neue Fassung), steht nach dem Laden in der Handy-Maske; ein veralteter Stand wird mit
`RECORD_CHANGED` abgewiesen und überschreibt nichts.
Im **Zwei-App-Lauf am echten Datenbestand** belegt (`26/0`): das Telefon legt an → PC2 sieht die
Kommission in seiner Liste (nach Einlieferer gruppiert, aufgeklappt mit der Nummer des Primary)
und denselben Artikel samt **beiden** Bildern über `products.get` → PC2 ändert den vereinbarten
Preis → das Telefon zeigt ihn nach dem Neuladen; die veraltete Handy-Änderung wird mit
`RECORD_CHANGED` abgewiesen und überschreibt nichts.

## 7. Schreibsicherheit

Der vorhandene Vertrag, unverändert übernommen: die Kennung gehört dem **Vorhaben** und wird vor
dem ersten Senden durabel abgelegt (IndexedDB, eigener Speicher `lataif_mobile_consignment`);
scheitert das, geht nichts hinaus. Verlorene Antwort → der Vorgang bleibt offen und sichtbar,
„Clarify now" wiederholt **dieselbe** Kennung (Replay statt zweiter Wirkung). Gleiche Kennung mit
anderem Rumpf wird gar nicht erst gesendet. Veralteter Stand → `expectedRevision` aus dem
**gelesenen** Datensatz. Unbekannte Felder weist der Primary ab (`onlyKnownFields`). Keine rohe
`/api/sync/push`-Mutation.

## 8. Freischaltung — nichts Neues

**Neue Reads: 1 (`products.duplicates.get`). Neue Mutations: 0. Registry vorher 175, nachher 176**
(1 Probe + 19 Auskünfte + 53 typisierte Auskünfte + 103 Buchungen); TS und Rust nennen denselben
Namen, und jede Zähl- und Zuwachs-Prüfung der Brücke wurde mitgezogen.
Die neue Auskunft ist die kleinste, die „Copy details" am Telefon **Primary-autoritativ** macht:
sie ruft `findPossibleDuplicates` und gibt die Merkmale durch `copiedAttributes` heraus (ohne
Seriennummer), damit weder Erkennung noch Kopierregel ein zweites Mal existieren.
Wiederverwendet: `consignments.list`, `consignments.get`, `consignments.create`,
`consignments.update`, `consignments.record_sale`, `consignments.record_payout`,
`consignments.mark_returned`, `products.get`, `products.update`, `customers.list`,
`customers.create`. Bewusst **nicht** mobil: `consignments.return_after_sale`,
`consignments.cancel_sale` (§ 0).

## 9. Nachweise und Grenzen

| Lauf | Ergebnis |
|---|---|
| `node test/preg5/mobile-consignment.test.ts` | **94/0** (neu §8 Copy-Details-Parität gegen den Quelltext des Rechners) (§1 Anlegen, §2 Auszahlungsmodelle, §3 Ändern, §4 Galerie, §5 Handlungen, §6 AI, §7 Verdrahtung/Vokabeln) |
| `node test/preg5/mobile-consignment-page.e2e.mjs` | **42/0** — die drei echten Dateien in einem echten Edge gegen einen Attrappen-Primary (inkl. „Copy details") |
| `node test/e2e/pre-g5-mobile-consignment.e2e.mjs` | **26/0**, `PRE_G5_MOBILE_CONSIGNMENT_E2E_PROVED` — echter Primary + echte `/mobile`-Seite in Edge + echtes PC2, isolierte Instanz (Port 3011, eigener Datenordner) |
| Brücken-Gates nach der neuen Auskunft (c4-authorization, c4-read-revocation, client-read-mode, write-foundation, customer/product/invoice-remote-write, c6, r5c/r5d/r5e/r5f, r6b, r6c–r6f final gates, masterdata, r7b, r4c-Matrix) | alle grün auf 176 |
| `node test/preg5/mobile-repair.test.ts` · `-ui` · `-page` | **125/0 · 35/0 · 21/0** (Nachbarn: der Auftraggeber reicht jetzt die Begründung des Primary durch) |
| `npx tsc -b` | rc 0 |
| `cargo check --lib` · `cargo test --lib -- mobile_field` | grün · **25/0** |

**Grenzen:**
- **Testaufbau (nicht Produkt):** die Anmeldung von PC2 im Zwei-App-Lauf ist wackelig — in 3 von
  6 Läufen kam der Ausweis trotz fünf Versuchen nicht zustande; der Lauf meldet das ehrlich und
  bricht die PC2-Prüfungen ab. Dieselbe Grenze steht im Reparaturschnitt.
- **Was der Zwei-App-Lauf zeigt:** K1 Anlegen (Kommission, Artikel mit den festen Werten des
  Hauses, Einstand = Erwartungswert 400 bei 500/20 %, SKU vom Primary, beide Fotos im
  Medienspeicher) · K2 Duplikatsfrage, „Copy details" aus der Autorität (Modell und Merkmale ja,
  Referenz nein), „Create anyway" als eigener Auftrag · K3 verlorene Antwort → Klärung unter
  derselben Kennung, keine zweite Kommission · K4/K5 PC2 · K6 eine Auszahlung ohne Verkauf weist
  der Primary ab (`NOTHING_TO_PAY_OUT`) · K7 keine eigene Datenbank auf PC2, kein `/api/sync/push`.
- **AI-Live:** der Aufruf gegen den echten Anbieter ist im Testaufbau nicht fahrbar (kein
  Schlüssel); geprüft sind Weg, Übernahme und Leitplanken.
- Mobil bewusst nicht: Post-Sale Return, Cancel Sale, das Ändern der Ware selbst (§ 0).
- Das Telefon braucht einen laufenden Primary; ohne Fenster antwortet die Brücke mit 503, und die
  Maske sagt das.
