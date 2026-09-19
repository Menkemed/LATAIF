# PRE-G5 — Reparaturen vom Telefon (Mobile Repair)

Stand 16.09.2026 · Basis `ba9897b` (R7C, gepusht) · Version 0.8.54 · Registry **175 → 175 (unverändert)** · kein Push/Tag/Release.
Status: **umgesetzt und lokal getestet — unabhängige Freigabe ausstehend.**

## 0. Was es vorher gab (Scope-Audit am echten Code)

Die Handy-Seite (`src-tauri/src/sync/mobile_page.rs`) hatte eine Reparatur-Maske aus v0.4.x. Sie schrieb **selbst**:
Kunde und Reparatur als rohe Zeilen über `/api/sync/push` (`mobile_page.rs` alt: `pushChanges`), mit einer auf dem
**Telefon erfundenen** Nummer `REP-MOB-<Zeitstempel>` und einem dort erzeugten Gutscheincode, dem Foto als Daten-URL
direkt in `repairs.images`. Kein Nachweis, keine Idempotenz, keine Fassungsprüfung, keine Validierung der Domäne —
also eine **zweite Reparaturlogik** neben der des Primary.

Matrix (Auszug; Vollbild aus dem Audit in `docs/central-ui-parity.md`):

| Repair-Aktion | vorhandene Domänenfunktion | Wirkung | Fernbefehl vorhanden | mobil nötig |
|---|---|---|---|---|
| Anlegen | `planRepairCreate` → `repairStore.createRepair` | Zeile, Nummer, Gutscheincode, Bestand, ggf. erste Arbeitszeile | **ja** `repairs.create` | **ja** |
| Kopf ändern | `buildRepairEditPatch` → `updateRepair` | Spalten, Kartengebühr, Kopfkosten, Marge | **ja** `repairs.update` | **ja** |
| Status | `repairStatusFlow` → `updateStatus` | Kosten buchen, Bestand, Marge | **ja** `repairs.update_status` | **ja** |
| Lesen | `repairs.list` / `repairs.get` | — | **ja** | **ja** |
| Arbeitszeile anlegen | `addRepairLineOnPrimary` | Zeile + A/P-Ausgabe, Revision | **ja** `repairs.add_line` | **ja** (V2) |
| Zeile zurücknehmen | `cancelRepairLineOnPrimary` | Zeile, Ausgabe, Zahlung und Buchung aufgelöst | **ja** `repairs.cancel_line` | **ja** (V2) |
| Material | `addRepairMaterialOnPrimary` | Zeilen + ggf. Goldschuld | **ja** `repairs.add_material` | **ja** (V2) |
| Goldeinsatz | `recordRepairGoldUsageOnPrimary` | Goldschuld / Kundengold-Guthaben | **ja** `repairs.record_gold_usage` | **ja** (V2) |
| Rechnung | `invoiceRepairsOnPrimary` | Rechnung + Zeilen, `invoice_id` | **ja** `repairs.create_invoice` | **ja** (V2) |
| Zeile ändern | nur im Store, **keine** Desktop-Benutzerfunktion | — | ja (`repairs.update_line`) | **nein** — was der Rechner nicht anbietet, bietet das Telefon auch nicht |
| Reparatur löschen | `deleteRepair` | destruktive Kaskade | **nein** (Primary-only, `C3G_PRIMARY_ONLY`) | **nein** |

**Ergebnis:** Für Mobile fehlte **keine** Domänenlogik und **keine** Operation — nur eine Oberfläche, die den
vorhandenen Weg benutzt. `PRE_G5_REPAIR_SCOPE_PROVED`

## 1. Der Weg (unverändert der von PC2)

```
Telefon (JWT)  →  POST /api/staging/media   (Fotos zuerst, Kennung = Hash der Bytes)
               →  POST /api/command {op, commandId, payload}
               →  routes.rs command_execute → Brücke → Renderer des Primary
               →  runRemoteCommand (eine Transaktion + durabler Nachweis)
               →  planRepairCreate / buildRepairEditPatch → repairStore
               →  authoritative DB
```

Mandant, Filiale, Benutzer und Rolle kommen ausschließlich aus dem geprüften Token (`routes.rs`), nie aus dem Rumpf.
Nummer, Gutscheincode, Status, Marge und Kosten rechnet der Primary. Das Telefon kann sie nicht einmal senden.

Neue Dateien (alle werden wörtlich in die Handy-Seite eingebettet, wie `mobile_upload_queue.js`):
- `src-tauri/src/sync/mobile_repair_commands.js` — Befehlsseite ohne DOM: Rumpfbau, Bildplan, Klassifikation der
  Antwort, durable Kennungen. In node prüfbar.
- `src-tauri/src/sync/mobile_repair_ui.js` — die Oberfläche (Liste, Suche, Erfassen, Bearbeiten, Fotos, Status, AI).
- `src-tauri/src/sync/mobile_repair.html` — das Markup.
Der Altweg ist **entfernt**: in `mobile_page.rs` gibt es kein `rSaveBtn`, kein `REP-MOB-`, keinen `repair`-Fotoplatz.

## 2. Oberfläche

Übersicht (`repairHome`): Suche über `repairs.list`, Liste, „New Repair Intake", Leiste **„Unresolved saves"**.
Maske (`formRepair`): Kunde wählen oder anlegen (`customers.list` / `customers.create`), bis zu **6 Fotos**
(Kamera/Galerie, erstes Foto antippen = nach vorn), Problem (Pflicht), Marke, Modell, Referenz, Seriennummer,
Beschreibung, geschätzte Kosten, Fertigstellung, Diagnose (nur beim Bearbeiten), Notizen; Arbeitszeilen als
**Auskunft** mit „Cancel line“ je offener Zeile; Statusknöpfe ausschließlich aus `allowedStatusTargets` des Primary.
Werkstattkarte (nur an einer bestehenden Reparatur): **Arbeitszeile** (Arbeitsart, Lieferant oder eigene Werkstatt,
Betrag, Text), **Material** (Art, Text, Lieferant, Menge, Kosten — dazu Karat je Stück bei Diamant/Stein bzw.
Gewicht und Karat beim Goldstück; die jeweils andere Angabe wird ausgeblendet, weil der Primary sie
abweist. `labor` bietet das Telefon nicht an, weil eine Reparatur diese Art nicht annimmt), **Goldeinsatz** (Werkstattgold mit
Lieferant und Abrechnung ODER Kundengold mit Verbrauch und Rest — die jeweils anderen Felder werden ausgeblendet,
weil der Primary einen gemischten Rumpf abweist) und **Rechnung** (Steuerart; der Knopf verschwindet, sobald eine
Rechnung existiert). Was der Rechner nicht anbietet (`repairs.update_line`) und was destruktiv ist (Löschen), fehlt
bewusst.

## 3. AI

Der vorhandene Weg `/api/ai/identify` wurde um eine **zweite Formart** erweitert (`kind: "repair"`), nicht dupliziert:
`src/core/ai/identify-contract.json` bekam einen Abschnitt `repair` mit eigenem Prompt; `ai_route.rs` filtert die
Antwort mit `filter_for_repair` auf **genau sechs** Felder — `itemBrand, itemModel, itemReference, itemSerial,
itemDescription, issueDescription`. Alles andere (Preise, Kosten, Kunde, Kennungen, Nummern, Status, Daten) wird
verworfen, nicht „ignoriert". Der Prompt verbietet es zusätzlich ausdrücklich. `kind` ohne Angabe = `product`, der
Produktweg ist unverändert.

Auf dem Telefon füllt `applyAiSuggestions` **nur leere** Felder und speichert nichts; jede Übernahme ist sichtbar
(„Filled N empty fields — please check before saving"). Der goldene Fingerabdruck des Vertrags
(`0b50cba3b834d514` → `0c33a03188de4b83`) hält TS und Rust zusammen. `PRE_G5_REPAIR_AI_PROVED`
**Grenze:** der Aufruf gegen den echten Anbieter ist im Zwei-App-Lauf **nicht** gefahren (kein Schlüssel im
Testaufbau); geprüft sind Vertrag, Filter und Übernahme (Rust 42/0, Einheit § 3).

## 4. Bilder

Dieselbe Infrastruktur wie PC2: Belegbild-Vertrag (JPEG ≤ 100 000 B, ≤ 1600 px, Metadaten weg), Ablage über
`/api/staging/media`, Kennung = SHA-256 der Bytes (der Server rechnet sie), Auflösung **innerhalb** des Befehls,
Verwerfen erst nach Erfolg. Bytes reisen nie in einem Befehl. Mehrere Fotos: Plan aus `{keep:i}` für gespeicherte und
`{stagingId}` für neue — gespeicherte Bilder werden nie neu gerechnet. Dasselbe Foto zweimal hochgeladen ergibt
dieselbe Kennung, also kein zweites Bild. Keine zweite Medienpipeline, kein Eingriff in Medien-GC oder Inbox.
Die Auskunft `repairs.get` gibt die gespeicherte Liste **Stelle für Stelle** heraus und lässt keinen
Eintrag weg: `{keep:i}` zählt genau auf diese Liste, ein Filter verschöbe jede folgende Stelle und ein
Speichern behielte still das falsche Foto. `PRE_G5_REPAIR_MEDIA_PROVED`

## 5. Primary + PC2

Ein Datensatz, drei Oberflächen. Im Zwei-App-Lauf belegt: das Telefon legt an → PC2 sieht die Reparatur in seiner
Liste → PC2 ändert sie über denselben Fernbefehl → das Telefon sieht die Änderung nach dem Neuladen. Kein
Mobile-Sonderformat, keine eigene Datenbank auf PC2. `PRE_G5_REPAIR_PC2_COMPAT_PROVED`

## 6. Schreibsicherheit

- Die Kennung (`commandId`) gehört dem **Vorhaben**: sie wird vor dem ersten Senden durabel abgelegt (IndexedDB),
  scheitert das Ablegen, geht nichts hinaus (`PENDING_STORE_FAILED`).
- Verlorene Antwort → Vorgang bleibt offen und sichtbar; „Clarify now" wiederholt **dieselbe** Kennung → Replay aus
  dem durablen Nachweis, keine zweite Reparatur.
- Gleiche Kennung, **anderer** Rumpf → wird gar nicht gesendet (`ORIGINAL_UNRESOLVED`, erst klären); ein Konflikt vom
  Primary (409 `outcome: not_executed`) hält den Vorgang offen.
- Veralteter Stand → `expectedRevision` aus dem **gelesenen** Datensatz; der Primary weist ab (`RECORD_CHANGED`), die
  Maske sagt es, nichts wird überschrieben.
- Der Rumpf trägt nur Felder, die die Maske zeigt (Fund aus dem Zwei-App-Lauf: sonst reiste `repairType: null` mit und
  hätte den Wert geleert — der Primary wies zu Recht ab).
- Unbekannte Felder scheitern schon am Primary (`onlyKnownFields`). `PRE_G5_REPAIR_WRITE_SAFETY_PROVED`

## 7. Freischaltung — nichts Neues

**Neue Reads: 0. Neue Mutations: 0. Registry vorher 175, nachher 175.**
Wiederverwendet: `repairs.list`, `repairs.get`, `repairs.create`, `repairs.update`, `repairs.update_status`,
`repairs.add_line`, `repairs.cancel_line`, `repairs.add_material`, `repairs.record_gold_usage`,
`repairs.create_invoice`, `customers.list`, `customers.create`, `suppliers.list`. Erweitert wurde nur der **vorhandene** Lese-DTO `repairs.get` um Felder, die eine
Maske ohne eigene Datenbank zum Bearbeiten braucht (`images`, `itemReference`, `itemDescription`, `itemCategoryId`,
`itemAttributes`, `staffId`); `repairs.list` bleibt ohne Bilder. Bewusst **nicht** mobil: `repairs.update_line` (am Rechner
gibt es dafür keine Benutzerfunktion) und das Löschen einer Reparatur (destruktiv, Primary-only). `PRE_G5_REPAIR_ALLOWLIST_PROVED`

## 8. Nachweise

| Lauf | Ergebnis |
|---|---|
| `node test/preg5/mobile-repair.test.ts` | **125/0** (§1 Rumpf/verbotene Felder, §2 Idempotenz, §3 AI-Leitplanken, §4 Verdrahtung, §5 keine Phantomfelder, §6 Werkstattwege, §7 Vokabeln des Hauses) |
| `node test/preg5/mobile-repair-ui.test.ts` | **20/0** — die Oberfläche mit DOM-Ersatz: Erfassen, Ändern, veralteter Stand, verlorene Antwort |
| `node test/preg5/mobile-repair-page.e2e.mjs` | **21/0** — dieselben drei Dateien in einem **echten** Browser gegen einen Attrappen-Server (Sekunden statt Minuten) |
| `node test/e2e/pre-g5-mobile-repair.e2e.mjs` | **30/0**, `PRE_G5_MOBILE_REPAIR_E2E_PROVED` — Primary + echte `/mobile`-Seite in Edge + PC2 |
| `node test/media04b2a9/upload-queue.test.ts` | **51/0** (Nachbar: Anker auf den Altweg auf die neue Wahrheit gezogen) |
| `npx tsc -b` | rc 0 |
| `cargo test --lib -- ai_identify ai_route first_run_ipc mobile_field` | **72/0** |
| Registry-Pins: `c4-authorization` **169/0**, `c6-release-hardening` **38/0**, `write-foundation`, `r5c/repair-parity` | grün |

**Zwei-App-Lauf im Einzelnen:** M1 Erfassen (Kunde + 2 Fotos, Nummer vom Primary, genau eine Nachweiszeile) ·
M2 Ändern (+ drittes Foto, alte Bilder Byte für Byte, Fassung steigt) · M3 verlorene Antwort (Antwort verworfen,
Primary hatte gebucht, „Clarify now" → Replay, keine zweite Reparatur) · M4 veralteter Stand (PC2 ändert zuerst →
`RECORD_CHANGED`, nichts überschrieben) · M5 beide Oberflächen sehen denselben Datensatz ·
**M7 Werkstatt am echten Datenbestand:** Arbeitszeile angelegt (`polishing`, 12,500) → dieselbe Zeile zurückgenommen
(Zeile und Ausgabe weg) → Status über die erlaubten Schritte bis `ready` → Kundenbetrag 45 gespeichert → Rechnung
erzeugt (`invoice_id` gesetzt, Brutto > 0), danach bietet die Maske keine zweite an · M6 Ablage danach leer,
jedes Bild JPEG ≤ 100 000 B, **nie** `/api/sync/push`, keine Datenbank auf PC2.

## 9. Gefundene Fehler (in diesem Schnitt behoben)

1. **Rückmeldung verschwand:** nach dem Speichern lud die Maske die Reparatur neu und löschte dabei ihre eigene
   Bestätigung — der Mensch sah nie, dass gespeichert wurde. (Gefunden im Zwei-App-Lauf.)
2. **Phantomfelder:** der Änderungsrumpf verglich auch Felder, die die Maske nicht zeigt (`repairType`), und hätte sie
   geleert; der Primary wies die ganze Änderung ab. (Gefunden im Zwei-App-Lauf, jetzt Einheitstest § 5.)
3. **Testaufbau:** liegengebliebene Test-Browser früherer Läufe hielten den Debug-Port — gemessen wurde eine **alte**
   Seite. Jetzt eigener Port je Lauf, Anbindung an die exakte Adresse, Aufräumen beim Start. Das kostete vier Läufe.

## 9b. Aus dem unabhängigen Review (nach `aefa96e` behoben)

1. **Die Materialkarte bot Sackgassen an:** `labor` weist der Primary an einer Reparatur immer ab
   (`addRepairMaterialInHouse` ruft `checkMaterialRows(..., allowLabor = false)`), und Diamant/Stein
   verlangen das Karat je Stück — dafür gab es auf dem Telefon kein Feld. Gewicht und Karat reisten
   außerdem unabhängig von der Art mit (`MATERIAL_FIELD_NOT_APPLICABLE`). Nutzbar war faktisch nur
   Gold. Jetzt bietet die Auswahl genau die Arten an, die eine Reparatur annimmt, und die Felder
   hängen an der Art — wie im Modal des Rechners.
2. **Der Bildindex konnte verrutschen:** `repairs.get` filterte die Bilder auf `data:image/`, die
   Auflösung von `{keep:i}` zählt aber auf die **ungefilterte** gespeicherte Liste
   (`resolvePhotos` gegen `seen.images`). Ein einziger anders geformter Eintrag hätte beim
   Speichern still das falsche Foto behalten. Jetzt bleibt jede Stelle erhalten.
3. **Die Vokabeln waren eine ungepinnte zweite Liste** (Arbeitsarten, Materialarten, Goldquellen,
   Rest-Ziele, Abrechnungsarten, Steuerarten, „eigene Werkstatt"). Genau die Falle aus R4C.3/R4C.4.
   § 7 des Einheitstests nagelt sie jetzt Zeichen für Zeichen an die Quelle des Hauses.
4. Diese Grenzenliste widersprach § 2 und § 7 (sie nannte die Werkstattwege als „nicht mobil",
   obwohl V2 sie gebaut hat) — unten korrigiert.

## 9c. Aus dem Feldversuch am Telefon (17.09.2026 behoben)

1. **„Create invoice" scheiterte mit „has no charge".** Die Maske fragt „Customer Pays (BHD)", aber
   `CREATE_FIELDS` des Telefons kannte `chargeToCustomer` nicht — der Betrag fiel beim ANLEGEN still weg,
   obwohl `parseRepairCreate` ihn ausdrücklich annimmt. Danach verweigerte der Rechnungsweg zu Recht
   (`REPAIR_HAS_NO_CHARGE`). Dieselbe Klasse wie die Materialsackgassen: ein Feld ohne Weg. Behoben; der
   Nachweis führt den Rumpf des Telefons durch den echten Anlagebefehl bis an die Frage des Rechnungswegs.
   Gegenprobe im Test: **jedes** beim Anlegen sichtbare Maskenfeld hat einen Weg (die Diagnose ist dort
   ausgeblendet, sie gehört zur Arbeit).
2. **Zeilen waren am Telefon nicht zu unterscheiden** („polishing · 12.5 · OPEN"). Alles Nötige stand
   längst in der Zeile, die Auskunft `repairs.get` gab es nur nicht heraus. Jetzt trägt sie Text, Art,
   Materialangaben und den Namen des Lieferanten — **keine neue Operation, Registry bleibt 176** —, und
   die Zeile heißt „Quelle · Art — Angaben — Text · Betrag · Stand".
3. **Materialangaben waren am Rechner unsichtbar.** Menge, Karat je Stück, Gewicht und Karat werden seit
   jeher gespeichert (`materialDetails`), die Kostenkarte zeigte aber nur die abgeleitete Spalte
   „COST/CT" — bei Gold nicht einmal die. Jetzt steht in der Beschreibung `3 × 0.25 ct — <Notiz>` bzw.
   `5.200 g · 21K — <Notiz>`. Betrag, Summe, A/P und jede Buchung unverändert.

**Nebenbefund aus diesem Lauf:** sechs Prüfdateien hielten noch die alte Teilzahl der geladenen Befehle
(59/18 bzw. 43/18) und waren seit `products.duplicates.get` rot — beim Zählerumbau auf 176 übersehen,
weil sie nicht die Registry zählen, sondern die Befehle IHRER Importe. Nur Zahlen in Tests, kein Produkt.

## 9d. Offener Feature-Gap — `Repair Gold Usage History`

**Frage aus dem Feldversuch:** ein Goldeinsatz vom KUNDEN war danach am Rechner nirgends zu sehen.

- **Was bei Kundengold mit Rest 0 dauerhaft gespeichert wird: nichts.** `recordRepairGoldUsageInHouse`
  prüft Karat und Gramm, rechnet den Rest — und kehrt bei `rest <= GRAM_EPS` zurück, ohne zu schreiben.
  Erst ein Rest erzeugt etwas: „credit" ein Kundengold-Guthaben, „shop_keep" einen Zufluss in den
  Hausbestand samt Eintrag. „return" — der Kunde nimmt den Rest mit — schreibt ebenfalls nichts.
  Es entsteht also keine Zeile, keine Schuld, kein Guthaben und kein Eintrag; die Reparatur selbst
  bleibt unverändert.
- **Gibt es schon einen Nachweis, aus dem PC2 oder das Telefon den Einsatz anzeigen könnten? Nein.**
  Das Befehlsbuch (`remote_command_ledger`) hält nur Name, Ausgang und den **Hash** der Nutzlast — die
  Gramm und das Karat stehen dort nicht, und für eine Erfassung am Rechner gibt es gar keinen Eintrag.
- **Deshalb offen als eigener Schnitt** `Repair Gold Usage History`: eine dauerhafte Spur je Goldeinsatz
  (Quelle, Karat, erhalten, verbraucht, Rest samt Verbleib), lesbar für Rechner und Telefon. Hier bewusst
  NICHT erfunden — das wäre neue Buchungslogik ohne Auftrag.
- **Kein Lieferant bei Kundengold:** der Hausvertrag verlangt ihn nur für Werkstattgold; die Maske am
  Telefon blendet das Feld für Kundengold aus. Vertrag und Maske sind einig — nichts zu ändern.

## 9e. Reparaturkosten doppelt gezählt (Live-Test 19.09.2026, behoben)

**Befund:** offene Zeilen 30 + 90 + 5 = 125, Kunde zahlt 150. Nach „Save Changes" stand
`internal_cost = 125`, der Rechnungseinstand war 250, die Marge −100.

**Kostenvertrag, am Code gemessen:**

| Feld / Teil | Bedeutung | wer schreibt | Marge | Rechnungseinstand |
|---|---|---|---|---|
| `internal_cost` | eigene Arbeit (bei `external` der gespiegelte Voranschlag) | Anlage `internalCostOnCreate`; „Save" `internalCostOnEdit` | ja, als `own` (nicht bei `external`) | ja, als `own` |
| `actual_cost` | seit den Kostenzeilen die **Summe der offenen Zeilen** | `recomputeRepairAggregates` bei jeder Zeile; das Formularfeld „ACTUAL COST" | nein (nur über den alten Fallback) | nein |
| offene `repair_lines` (Arbeit, Material, Werkstatt) | je eine Kostenposition | `add_line` / `add_material` / automatische Werkstattzeile | ja, als `lines` | ja, als `lines` |
| zurückgenommene Zeile | gelöscht, samt Ausgabe und Goldschuld | `cancelRepairLine` | nein | nein |
| Gebühr (`fee`) | nur ohne Zeilen, mit verknüpfter Werkstatt (Altbestand) | — | ja | ja |
| Goldschuld / Kundengold | Gramm-Konten, kein Teil der BHD-Kosten der Reparatur | Goldkern | nein | nein |

`repairCostParts(own, lines, fee)` ist der EINE Vertrag: Marge (`updateRepair`,
`recomputeRepairAggregates`, Statuswechsel), Rechnungseinstand und Kopfbuchung bei „ready"
(`syncRepairHeaderCosts`) lesen ihn. Falsch war nur ein **Eingang**: `internalCostOnEdit` nahm bei
leerer eigener Arbeit `actual_cost` (oder den Voranschlag) als eigene Arbeit — aus der Zeit vor den
Zeilen, als `actual_cost` noch der Aufwand war. Mit Zeilen ist es deren Summe → doppelt gezählt.

**Fix:** sind Kostenzeilen offen, leitet `internalCostOnEdit` nichts mehr ab — eigene Arbeit gibt
es dann nur, wenn sie eingetragen ist. Ohne Zeilen bleibt der alte Vertrag. Beide Anschlüsse
(„Save" am Primary und `repairs.update`) reichen die offenen Zeilen durch. Keine zweite
Kostenlogik, keine Änderung an `repairCostParts`, Buchung, Werkstatt oder Gold.

**Bestehende Daten — keine automatische Korrektur.** Betroffen sein kann jede Reparatur, an der
nach dem Erfassen von Zeilen „Save" gedrückt wurde, ohne eigene Arbeit einzutragen. Zuverlässig
unterscheiden lässt sich das NICHT: der falsche Wert ist die Zeilensumme **zum Zeitpunkt des
ersten Speicherns** und bleibt danach stehen (er gilt ab dann als „eingetragen"), auch wenn sich
die Zeilen später ändern — und eine echte eigene Arbeit kann zufällig genauso hoch sein.
Kandidaten findet diese Abfrage (nur lesen):

```sql
SELECT r.repair_number, r.repair_type, r.internal_cost, r.actual_cost,
       (SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines l
         WHERE l.repair_id = r.id AND l.status = 'OPEN') AS zeilen,
       r.invoice_id IS NOT NULL AS abgerechnet
  FROM repairs r
 WHERE r.internal_cost > 0 AND r.repair_type <> 'hybrid'
   AND EXISTS (SELECT 1 FROM repair_lines l WHERE l.repair_id = r.id AND l.status = 'OPEN');
```

Korrektur je Kandidat, von Hand und nur nach Prüfung: in der Reparatur „INTERNAL COST" auf 0 setzen
und speichern — Marge und (bei „ready") die Kopfbuchung folgen dem Vertrag. Eine **abgerechnete**
Reparatur ändert ihre Kosten nicht mehr (`REPAIR_ALREADY_INVOICED`); dort bleibt nur eine
Korrektur über die Rechnung. Stand der Produktion am 19.09.2026 (Kopie, gelesen): genau **eine**
Reparatur, die Testreparatur `REP-2026-00001` (abgerechnet) — sie verschwindet mit dem geplanten
Zurückspielen der Sicherung.

## 10. Grenzen

- **AI-Live-Nachweis offen (manuell):** ohne hinterlegten Schlüssel ist der Aufruf gegen den echten Anbieter im
  Testaufbau nicht fahrbar. Offener Handnachweis: auf einem Primary mit Schlüssel ein Reparaturfoto aufnehmen,
  „AI Identify“ drücken und prüfen, dass nur leere beschreibende Felder gefüllt werden.
- **Testaufbau (nicht Produkt):** die Anmeldung von PC2 im Zwei-App-Lauf ist gelegentlich wackelig (in 2 von 7 Läufen
  kam der Ausweis nicht zustande); der Lauf wiederholt sie dreimal und schreibt bei Fehlschlag auf, was die Maske
  zeigt. Betrifft nur den Test.
- **G5** Ganz-DB-Speichern skaliert mit der Dateigröße — **OPEN, nicht akzeptiert**, von diesem Schnitt unberührt.
- AI gegen den echten Anbieter im Zwei-App-Lauf nicht gefahren (§ 3).
- Mobil bewusst nicht: `repairs.update_line` (am Rechner gibt es dafür keine Benutzerfunktion) und
  das Löschen einer Reparatur (destruktiv, Primary-only) — § 7. Die Werkstattwege (Arbeitszeile,
  Storno, Material, Gold, Rechnung) sind seit `aefa96e` gebaut, siehe § 2.
- Materialart `labor` gibt es am Telefon nicht, weil eine Reparatur sie nicht annimmt (§ 9b.1) —
  das ist keine Lücke gegenüber dem Rechner, der sie dort ebenso wenig anbietet.
- Das Telefon braucht einen laufenden Primary (wie PC2): ohne Fenster am Primary antwortet die Brücke mit 503, und die
  Maske sagt das.
- Die Ablage offener Vorgänge liegt im IndexedDB **dieses** Browsers; ein anderes Telefon sieht sie nicht.
