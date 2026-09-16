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
| Arbeitszeile, Material, Gold, Rechnung, Löschen | `addRepairLine…`, `gold-house`, `createCombinedRepairInvoice`, `deleteRepair` | Geld, Lieferanten, Hauptbuch | ja (Löschen: Primary-only) | **nein** (bewusst, § 7) |

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
**Auskunft**; Statusknöpfe ausschließlich aus `allowedStatusTargets` des Primary.

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
`PRE_G5_REPAIR_MEDIA_PROVED`

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
`customers.list`, `customers.create`. Erweitert wurde nur der **vorhandene** Lese-DTO `repairs.get` um Felder, die eine
Maske ohne eigene Datenbank zum Bearbeiten braucht (`images`, `itemReference`, `itemDescription`, `itemCategoryId`,
`itemAttributes`, `staffId`); `repairs.list` bleibt ohne Bilder. Bewusst **nicht** mobil: Arbeitszeilen, Material,
Gold, Rechnung, Löschen — Geld- und Lieferantenwege bleiben am Rechner. `PRE_G5_REPAIR_ALLOWLIST_PROVED`

## 8. Nachweise

| Lauf | Ergebnis |
|---|---|
| `node test/preg5/mobile-repair.test.ts` | **86/0** (§1 Rumpf/verbotene Felder, §2 Idempotenz, §3 AI-Leitplanken, §4 Verdrahtung, §5 keine Phantomfelder) |
| `node test/preg5/mobile-repair-ui.test.ts` | **20/0** — die Oberfläche mit DOM-Ersatz: Erfassen, Ändern, veralteter Stand, verlorene Antwort |
| `node test/preg5/mobile-repair-page.e2e.mjs` | **13/0** — dieselben drei Dateien in einem **echten** Browser gegen einen Attrappen-Server (Sekunden statt Minuten) |
| `node test/e2e/pre-g5-mobile-repair.e2e.mjs` | **25/0**, `PRE_G5_MOBILE_REPAIR_E2E_PROVED` — Primary + echte `/mobile`-Seite in Edge + PC2 |
| `node test/media04b2a9/upload-queue.test.ts` | **51/0** (Nachbar: Anker auf den Altweg auf die neue Wahrheit gezogen) |
| `npx tsc -b` | rc 0 |
| `cargo test --lib -- ai_identify ai_route first_run_ipc mobile_field` | **72/0** |
| Registry-Pins: `c4-authorization` **169/0**, `c6-release-hardening` **38/0**, `write-foundation`, `r5c/repair-parity` | grün |

**Zwei-App-Lauf im Einzelnen:** M1 Erfassen (Kunde + 2 Fotos, Nummer vom Primary, genau eine Nachweiszeile) ·
M2 Ändern (+ drittes Foto, alte Bilder Byte für Byte, Fassung steigt) · M3 verlorene Antwort (Antwort verworfen,
Primary hatte gebucht, „Clarify now" → Replay, keine zweite Reparatur) · M4 veralteter Stand (PC2 ändert zuerst →
`RECORD_CHANGED`, nichts überschrieben) · M5 beide Oberflächen sehen denselben Datensatz · M6 Ablage danach leer,
jedes Bild JPEG ≤ 100 000 B, **nie** `/api/sync/push`, keine Datenbank auf PC2.

## 9. Gefundene Fehler (in diesem Schnitt behoben)

1. **Rückmeldung verschwand:** nach dem Speichern lud die Maske die Reparatur neu und löschte dabei ihre eigene
   Bestätigung — der Mensch sah nie, dass gespeichert wurde. (Gefunden im Zwei-App-Lauf.)
2. **Phantomfelder:** der Änderungsrumpf verglich auch Felder, die die Maske nicht zeigt (`repairType`), und hätte sie
   geleert; der Primary wies die ganze Änderung ab. (Gefunden im Zwei-App-Lauf, jetzt Einheitstest § 5.)
3. **Testaufbau:** liegengebliebene Test-Browser früherer Läufe hielten den Debug-Port — gemessen wurde eine **alte**
   Seite. Jetzt eigener Port je Lauf, Anbindung an die exakte Adresse, Aufräumen beim Start. Das kostete vier Läufe.

## 10. Grenzen

- **G5** Ganz-DB-Speichern skaliert mit der Dateigröße — **OPEN, nicht akzeptiert**, von diesem Schnitt unberührt.
- AI gegen den echten Anbieter im Zwei-App-Lauf nicht gefahren (§ 3).
- Mobil bewusst nicht: Arbeitszeilen, Material, Gold, Rechnung, Löschen (§ 7).
- Das Telefon braucht einen laufenden Primary (wie PC2): ohne Fenster am Primary antwortet die Brücke mit 503, und die
  Maske sagt das.
- Die Ablage offener Vorgänge liegt im IndexedDB **dieses** Browsers; ein anderes Telefon sieht sie nicht.
