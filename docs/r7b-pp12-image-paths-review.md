# R7B / PP-12 — Bildwege, Frist nach der echten Speicherung, reguläres Beenden

Stand 15.09.2026 (Abschlussprüfung, Nachtrag) · Basis `0a15565` (PP-12-Abschluss) auf `243e4e6` · Version 0.8.54 ·
Registry 175 (unverändert) · kein Push/Tag/Release. PP-3 … PP-7 gelten als geschlossen und wurden nicht angefasst.

## 0. Status je Punkt (jeder mit eigenem Beleg; keine Sammel-Aussage)

| Punkt | Status | Beleg (Einzelheiten im Abschnitt) |
|---|---|---|
| **PP-12 Frist der Dokumentwege** (DB-Größe + Wachstum, normale Befehle 20 s) | **geschlossen** (unverändert seit `1479b09`) | § 7; `r7b-pp12-large-db` 13/0 (bis 451/518 MB) |
| **F4 Reguläres Beenden bei großer DB** | **behoben** — Ursache gefunden, vorbestehend (Baseline `d988810`) | § 1; Nachstellung HEAD vorher + Baseline hängen, `r7b-pp12-shutdown` **14/0** (518 MB, Abgleich unterwegs: endet nach 23,9 s) |
| **G2 Handy-Reparatur / Einkaufs-Inbox ohne Byte-Grenze** | **behoben** — Normalisierung bei der Übernahme (Abholen), Umweg → Quarantäne | § 2; `pp12-pulled-images` 26/0, `r7b-pp12-mobile-takeover` **20/0** |
| **G3 Artikelbilder in `products.images`** (Einkauf/Auftrag „New Item") | **zusammengeführt** — derselbe Cutover-Dienst wie beim Bearbeiten: Medienspeicher + Vorschau nach dem Commit | § 3; `pp12-new-item-media` 17/0, Mobile-Lauf 20/0, `r7b-pp12-images` **22/0** |
| Verbliebene `products.images`-Schreiber | **begründet** (kein neues Foto / Migration / Abgleich-Transport) | § 3 Tabelle |
| **G7 Aufnahmeprofil 800 px (Desktop) vs. 1600 px (Handy)** | **gemessen begründet** (Phasen + Bildqualität); der ursprüngliche 504 neu erklärt | § 4 |
| **G4 Keine Vorschau für Belegbilder** | begründet, unverändert (Vorschau gibt es nur, wo ein Medienspeicher-Objekt entsteht) | § 2 |
| **G6 Schlangenwartezeit / weiterlaufende Mutation** | **dokumentiert**, Wiederholungssicherheit belegt; offen (keine Ergebnisabfrage ohne erneutes Senden) | § 5 |
| **F1 „kein fsync"** | **eingeordnet**: neustartfest ja, stromausfallfest nein (Befund, nicht geändert) | § 6 |
| **G5 Normale Befehle 10,7 s bei 451 MB** | **Skalierungsbefund**, offen (keine pauschale Fristerhöhung, kein Speicherumbau) | § 8 |
| **F2 Handy-Drain-Lease ohne Verlängerung** | Beobachtung, unverändert | § 8 |
| **Rust `legacy_push_tests::o1_o5_o10`** | **behoben** — Erwartung aus dem kanonischen Manifest (52/36/37), vorbestehend rot seit `ab7f169` | § 9 |

## 1. Reguläres Beenden bei großer Datenbank (F4)

**Nachstellung** (isolierte Test-DB `com.lataif.app.e2e`, Port 3011, nur eigene PID am exakten Test-Pfad; die Spur ist reine
Beobachtung: Kern-Aufrufe `plugin:fs|write_file/rename`, `finalize_application_shutdown`, `/api/sync/push|pull`, Overlay-Text,
Warnungen — keine Zeile der Anwendung ersetzt):

| Lauf | Programm | Zustand beim Schließen | Ergebnis |
|---|---|---|---|
| Buchung + Foto, 2 → 355 MB | HEAD vorher | nichts unterwegs | endet 1,7 s |
| größtes Dokument / Texterkennung, 69 → 422 MB | HEAD vorher | nichts unterwegs (Selbst-Abgleich lief nicht: 401) | endet 1,6–1,7 s |
| 1 bzw. 3 Befehle unterwegs, 451 MB | HEAD vorher | Speichern eines Befehls läuft | endet 2,8–2,9 s (Befehl 2/3: `BRIDGE_RENDERER_RELOADED` = Ausgang offen) |
| exakte Abfolge des alten Laufs (normal → 25-MB-Dokument → kleiner Upload → Texterkennung), 518 MB | HEAD vorher | **Selbst-Abgleich des Primary läuft** | **hängt**: Overlay „Save failed — Relaunch aborted: 'flushing' did not complete within 8000 ms" nach 9,0 s, Prozess lebt nach 241 s |
| dieselbe Abfolge, Abgleich deterministisch unterwegs (Schließen direkt nach `sync push start`) | **Baseline `d988810`** (gepushter Stand, eigener E2E-Build) | Selbst-Abgleich läuft | **hängt** genauso: Overlay nach 9,1 s, Prozess lebt nach 242 s; danach alle 30 s ein leerer Abgleich |
| dieselbe Abfolge ohne Abgleich unterwegs | Baseline `d988810` | nichts unterwegs | endet 1,8 s |
| Beweislauf `r7b-pp12-shutdown` (Abgleich an, deterministisch unterwegs) | **HEAD nachher** | Selbst-Abgleich läuft | **endet regulär nach 23,9 s** (wartet den Abgleich ab, dann Flush + Finalizer); kein Overlay-Fehler |

**Der wartende Schritt:** `prepareAndCloseApplication` → `waitForPendingOperations` = `withTimeout(sync.waitForSyncIdle(), 8000)`.
Nicht die Mutation, nicht der Flush, kein Worker, nicht die Prozessbeendigung: der **Scheduler-Auftrag „Abgleich"** (`syncNow`,
im exklusiven Platz). Der Primary gleicht mit seinem eigenen Server ab (eigene Änderungen hoch, das Echo zurück); nach einer
Buchung speichert dieser Lauf die ganze Datenbank bis zu zweimal (`saveDatabase()` nach dem Markieren, `saveDatabaseDurably()` nach
dem Abholen) — bei 518 MB je ~13 s. Die Frist von 8 s läuft ab, das Beenden bricht nach Regel A/B sichtbar ab („Please close again
to retry"), der Abgleich wird wieder freigegeben, und niemand schließt ein zweites Mal → der Prozess „endet nicht". Genau das ist
auch der Grund der 40-s-Antworten des kleinen Uploads: er stand in der Schreibreihenfolge hinter den zwei Speicherungen.

**Neu oder vorbestehend:** vorbestehend. `SYNC_IDLE_TIMEOUT_MS = 8000` / `FLUSH_TIMEOUT_MS = 15000` stammen aus `0e5e852`
(03.08.2026); Close-Pfad, Abgleich und Speichern sind zwischen `d988810` und `0a15565` unverändert; die Baseline-Binary hängt
identisch. Frühere Läufe endeten nur, wenn beim Schließen gerade kein Abgleich lief (nicht deterministisch).

**Behebung (konkrete Ursache):** die Wartefristen kennen die Datenbankgröße — dieselbe Untergrenze wie die Brücke (PP-12):

```
syncIdle = 8 s  + 2 × dbBytes / 4 MB/s      flush = 15 s + 2 × dbBytes / 4 MB/s     (dbBytes = zuletzt geladene/geschriebene Datei)
2 MB → 9 s / 16 s        518 MB → 267 s / 274 s (gemessen: Abgleich ~26 s, Speichern ~13 s)
```

`relaunch-coordinator.ts` (`saveAtFloorMs`, `syncIdleBudgetMs`, `flushBudgetMs`, Operation `dbBytes`), `database.ts`
`getLastPersistedDbBytes()` (kein Export, kein Dateizugriff), angeschlossen an jedem Wartepunkt auf Abgleich/Flush: Fenster
schließen und Neuladen (`App.tsx`), Backup-Neustart, Medien-Aufräumen, Wiederherstellen (`restore-wiring.ts`), Updater
(`UpdateBanner.tsx`), Datenort-Umzug (`data-root-move.ts`). Unverändert: Regel A/B (geschlossen wird nur nach bestätigtem Flush,
sonst sichtbarer Fehler, App bleibt offen), kein erzwungenes Ende, Single-Flight, Finalizer. Die Frist bleibt eine Frist; läuft
sie ab (z. B. ein hängender Abgleich), bricht das Beenden weiter sichtbar ab.

**Nachweis:** `test/r7b/pp12-close-budget.test.ts` **19/0** (Fristen gegen die Untergrenze aus `bridge.rs`, Koordinator,
jeder Wartepunkt verdrahtet, Regel A/B unverändert); Nachbarn `m4 window-close-persistence` 50/50, `m5 reload-persistence` 30/30,
`post-release-shutdown relaunch-coordinator` 28/28, `restore-wiring` 15/0, `backup-workflow` 20/0.
`test/e2e/r7b-pp12-shutdown.e2e.mjs` **14/0** (`POST_PARITY_PP12_REGULAR_CLOSE_LARGE_DATABASE_PROVED`, HEAD-Build): Selbst-Abgleich
des Primary an wie in der Produktion; geschlossen wird wie ein Mensch (CDP-Verbindung zu, WM_CLOSE, kein zweiter Klick).

| Schritt | DB | Ergebnis |
|---|---|---|
| bestätigte Buchung + Belegfoto, schließen | 2 MB | endet 1,7 s |
| Füllen (Anwendung zu), Neustart | 451 MB | angemeldet, erreichbar, Abgleich an, kleine Stufe da |
| Buchung + Foto · größtes Dokument (200, 42,6 s) · kleiner Upload (200, 42,5 s) · Texterkennung (200, 14,8 s) | 451 → 518 MB | jede Wirkung in der Datei |
| letzte Buchung, warten bis `sync push start`, **schließen während der Abgleich läuft** | 518 MB | **endet regulär nach 23,9 s**, kein „Save failed" |
| Neustart | 518 MB | Buchungen, Fotos Byte für Byte, Dokumente, Texterkennung da; Foto wird angezeigt |
| schließen ohne neue Buchung | 518 MB | endet 1,7 s |
| erzwungenes Ende in diesem Lauf | — | **keines** |

## 2. Handy-Reparatur und Einkaufs-Inbox (G2)

**Callpath** (vorher, `file:line` im Stand `0a15565`):

| Schritt | Ort | Grenze |
|---|---|---|
| Aufnahme | `mobile_page.rs:1729` `resizePhoto(file, 1600, 0.85)` (Canvas, ein Durchgang) | kein Byte-Ziel |
| Zeile | `mobile_page.rs:2212` `images: JSON.stringify([dataUrl])` (+ Kunde `:2216-2219`); Inbox `:2241`, `:2246` | — |
| Transport | `mobile_page.rs:1940` → `routes.rs` `sync_push` | Rumpf ≤ 50 MiB, eine Änderung ≤ 32 MiB, Spalten-Allowlist — **keine Bildprüfung** |
| Ablage | `sync_changelog` des Servers, wörtlich | — |
| **Übernahme** | Primary `pullChanges` → `applySyncChange` → `applyUpsert` | 32 MiB — **keine Bildprüfung** |
| Ziel | `repairs.images`, `purchase_inbox.images` | — |

Die Byte-Grenze fehlte an **jeder** Stelle; normalisiert wurde nirgends (erst beim späteren Einkauf „New Item" das Inbox-Foto).
Derselbe Eingang (`/api/sync/push`) nimmt von jedem angemeldeten Rechner jede Bildspalte des Manifests an (`repairs`,
`purchase_inbox`, `products`, `precious_metals`, `suppliers.cpr_image`, `orders.custom_product_spec`) — ein Umweg an allen
Desktop-Normalisierungen vorbei.

**Behebung an der endgültigen Übernahme** (`src/core/sync/pulled-record-images.ts`, `sync-service.ts` `pullChanges`): vor der
Transaktion des Stapels, im selben exklusiven Platz, geht jedes NEUE Foto jeder Bildspalte durch den EINEN Normalisierer
(`normalizeRecordImages` → Rust `normalize_stock_image`: JPEG, ≤ 100 000 B, ≤ 1600 px, EXIF-Ausrichtung, Metadaten weg). Ein
schon gespeichertes Foto derselben Zeile bleibt Byte für Byte (`keep`) — der Primary spielt seine eigenen Änderungen beim
nächsten Abholen wieder ein; ein Altbild wird dadurch nicht umgerechnet. Ein unspeicherbares Foto (fester Code) oder ein
Verweis statt eines Fotos macht die GANZE Änderung zum Quarantänefall (`SYNC_RECORD_IMAGE_REJECTED`, dieselbe Transaktion, der
Stapel läuft weiter) — nichts halb, nichts still ohne Foto. Ist der Normalisierer nicht erreichbar, ist das kein Urteil: der
Stapel wird nicht übernommen, der Stand rückt nicht vor. Dokumente (`documents.file_path`) sind ausgenommen (Original =
OCR-Vorlage). Warum nicht im Abgleich-Server (`sync_push`): dort liegt der Transportvertrag (gespeichert wird, was gesendet
wurde), und das Echo eigener Altzeilen würde im Server-Log umgerechnet, ohne dass die Geschäftszeile es erfährt.

**Handy-Collection** (`/api/mobile/upload`, Drain, `ingest.prepare`) war schon der zentrale Weg (Hauptbild ≤ 100 000 B +
Vorschau ≤ 20 000 B); unverändert. **Vorschau für Belegbilder (G4):** Reparatur-/Inbox-/Altgold-/Ausweisfotos wohnen in ihrer
Zeile; eine Vorschau entsteht nur für ein Medienspeicher-Objekt. Das Inbox-Foto bekommt seine Vorschau, sobald es als Artikel
übernommen wird (§ 3).

**Nachweis:** `test/r7b/pp12-pulled-images.test.ts` **26/0** (Formen JSON-Text/Feld/Einzelfoto/Auftragsentwurf, `keep`,
fremde Zeile, Ablehnung → Quarantäne, kein Urteil → Stapel bleibt, Dokument/Löschen unberührt, jede Foto-Spalte des Manifests
abgedeckt, Verdrahtung vor `commitPulledBatch`). `test/e2e/r7b-pp12-mobile-takeover.e2e.mjs` **20/0**
(`POST_PARITY_PP12_MOBILE_TAKEOVER_AND_NEW_ITEM_MEDIA_PROVED`, HEAD-Build, Primary + PC2): gesendet werden genau die Zeilen der
Handy-Seite (Pin auf `mobile_page.rs`: `resizePhoto(file, 1600, 0.85)`, Kunde + Reparatur, Inbox, `/api/sync/push`), die Fotos wie
dort erzeugt (Kamera 3000×2000 → 1600 px / 0,85). Übernommen nach 88 s (Abgleich alle 30 s): Reparaturfoto 474 184 B 1600×1067
→ **89 841 B 982×655**, Inbox-Foto 475 075 B → **90 475 B 982×655** (JPEG, ohne Metadaten); kaputtes Foto + Verweis über
denselben Eingang → 2 Quarantänefälle, nichts übernommen, die gültige Reparatur daneben schon; Ergänzen: gespeichertes Foto Byte
für Byte, das neue normalisiert; Anzeige Primary + PC2 (angemeldet als B); regulärer Neustart: alles Byte für Byte.
Befund des ersten Anlaufs (Harness, nicht Produkt): der Primary hatte im Testaufbau noch keinen Abgleichsstand mit seinem Server
(sein Selbst-Abgleich scheiterte vorher mit 401) — die Historie begann mit Handy-Änderungen, und der bestehende Vertrag
SYNC-SAFETY-A1 hielt das Abholen korrekt an (`recovery-required`, `sync_cursor` leer). Der Lauf wartet jetzt wie die Produktion
auf den Stand des Primary (29 s), bevor das Handy sendet.

Kosten: das Normalisieren läuft beim Abholen im exklusiven Platz (Release ~1,6 s je 1600-px-Handyfoto, § 4) — ein Stapel mit
vielen Handyfotos verzögert nachfolgende Aufträge entsprechend (G6).

## 3. `products.images` — alle Schreibwege

| Schreiber | Aufrufer | vorher | nachher |
|---|---|---|---|
| `createProduct` (`productStore.ts`) | Einkauf „New Item" (`purchaseStore.ts:360`), Auftrag Neuanlage (`orderStore.ts:494`), Positionsänderung (`:1003`), Storno Sonderstück (`:1461`), Alt-Umwandlung (`OrderDetail.tsx:638`), Rechnung aus Auftrag (`order-invoice-lines.ts:66`) | normalisierte Fotos (PP-12) in der Spalte, **keine Vorschau** | **Medienspeicher**: `scheduleNewItemMediaCutover(id)` → als NÄCHSTER Auftrag der Schreibreihenfolge (nach Commit + durablem Speichern) `ProductMediaCutoverService.ensureProductMediaCutover` — alle Fotos in Reihenfolge durabel importiert (Hauptbild + Vorschau), geprüft, DANN `products.images = '[]'` (durabel) |
| `createProductWithMedia` / `editProductWithMedia` | Sammlung, PC2-Artikel, Kommission, Fertigung, Handy-Drain, Artikel bearbeiten | Medienspeicher | unverändert |
| `createProduct` | Excel-Import (`ImportPage.tsx:185`) | `images: []` | unverändert (kein Foto → kein Umzug) |
| Inline-INSERT | Einkauf ohne Artikel-Spec (`purchaseStore.ts:373`) | `'[]'` | unverändert |
| `mergeIntoExisting` | Dubletten-Zusammenführung (`SyncDuplicateGuard`) | kopiert ein VORHANDENES `images[0]` | unverändert — kein neues Foto; eine Umwandlung wäre eine Konvertierung bestehender Medien |
| Migration `backfillConsumedProducts`, Speicherpflege-Cutover, Service-Artikel, Seed | `database.ts`, `legacy-media-wiring.ts`, `repairStore.ts` | Bestand / `'[]'` | unverändert (Bestand bleibt) |
| Abgleich-Übernahme (`applyUpsert`) | abgeholte Produktzeile | wörtlich | **normalisiert** bei der Übernahme (§ 2); bleibt Spalte, weil die Zeile das Transportformat des Abgleichs ist (ausgelieferte Clients gleichen seit C6 nicht mehr ab) |

Warum nicht `createProductWithMedia` IN der Einkaufs-/Auftragsklammer: diese Geldwege sind synchron und laufen in einer
Transaktion mit Zeilen und Hauptbuch; der Medienweg schreibt Dateien und ist asynchron. Der Cutover-Dienst ist der vorhandene,
schon doppelt benutzte Umzug (Bearbeiten eines Altartikels, Speicherpflege) mit dem Vertrag „erst alle Bilder durabel, dann die
Spalte". Scheitert er, bleibt die Spalte die Wahrheit (das Foto wird weiter gezeigt), gemeldet; die Speicherpflege holt ihn nach.
Ein zurückgenommener Vorgang hinterlässt keinen Artikel — der Dienst findet nichts. Bestehende Artikel werden nie angefasst (nur
Kennungen, die `createProduct` in diesem Leben mit Fotos anlegte). Filiale/Mandant kommen aus der Artikelzeile (auch für PC2).
Das Leeren der Spalte wird wie jede Änderung erfasst (`trackUpdate`): die Abgleich-Zeile der Anlage trägt die volle Zeile MIT
Fotos, und der Primary spielt seine eigenen Änderungen beim nächsten Abholen wieder ein — ohne die zweite Zeile hätte das Echo
die Spalte wieder gefüllt (bei der Prüfung des eigenen Umbaus gefunden, Folgecommit; der Handy-Lauf prüft die leere Spalte nach
mehreren Abgleichsläufen und dem Neustart).
Kosten: je Foto ein Import mit durablem Checkpoint (ganze DB) — derselbe Preis wie jeder Medienspeicher-Artikel (G5).

**Nachweis:** `test/r7b/pp12-new-item-media.test.ts` **17/0** (Reihenfolge nach dem Vorgang, ein Umzugsauftrag, zurückgenommen →
nichts, Fehler → Spalte bleibt, nur `createProduct` mit Fotos, jeder synchrone Anlageweg, Echo-fest). Mobile-Lauf: Inbox → Einkauf
„New Item" über den Fernweg (Befehl 200 in 547 ms) → Hauptbild **95 406 B** + Vorschau **16 731 B** als Dateien, `products.images
= '[]'`, Inbox erledigt; Auftrag „New Item" → **81 447 B** + **19 273 B**, Spalte leer; nach mehreren Abgleichsläufen und dem
Neustart unverändert (Echo füllt nichts). `r7b-pp12-images` **22/0** (Einkauf „New Item" vom PC2: genau eine Medienverknüpfung + eine Vorschau, `products.images = '[]'`;
Anzeige Primary + PC2; regulärer Neustart mit Hauptbild/Vorschau-Dateien unverändert). Die übrigen Belegbildwege desselben Laufs
unverändert grün: PC2-Reparatur (Aufnahmen 84 785–94 478 B → normalisiert 55 458–99 526 B, Byte für Byte übernommen, 622 ms),
Rückfall roh 399 644 B → 91 026 B (3,3 s Debug), Primary-Maske 2 653 984 B → 97 454 B 800×533, Wiederholung, Ersetzen, Ausweis,
Altgold-`keep`, Medienspeicher-Artikel 99 526 B + 16 337 B.

## 4. Aufnahmeprofil 800 px (Desktop) vs. 1600 px (Handy) — gemessen

**Messaufbau** (`_tmp-r7b-capture-measure`, im Fenster des Primary — derselbe WebView-Canvas wie die Masken, Debug-Build):
Vorlage 3000×2000 (Kamera-JPEG q0,92); Desktop-Fassung wie `captureImage` (≤ 800 px, q0,7, weiß hinterlegt), Handy-Fassung wie
`resizePhoto(file, 1600, 0.85)`; jede durch `media_normalize_record_image`; Qualität = PSNR des GESPEICHERTEN Bilds gegen die
Vorlage in der Anzeigegröße 800×533 und 1600×1067. Release-Zeiten aus der vorhandenen Bench (`record_image`, `--release`).

| Vorlage | Fassung | gesendet | normalisiert (Debug) | gespeichert | PSNR 800 px | PSNR 1600 px |
|---|---|---|---|---|---|---|
| Probe 1 (mäßiges Rauschen; zwei Läufe) | Kamera roh | 2 177 772 B | 62,2–65,7 s | 98 433 B 982×655 | 31,19 dB | 28,04 dB |
| | Handy 1600 / 0,85 | 422 124 B | 29,8–31,0 s | 96 346 B 982×655 | 30,80 dB | 27,75 dB |
| | Desktop 800 / 0,7 | 82 230 B | 1,19–1,27 s | 96 579 B 800×533 | 27,41 dB | 26,09 dB |
| | gespeicherte Form erneut (Prüfung beim Abholen) | 96 579 B | 0,27 s | Byte für Byte gleich | — | — |
| Probe 2 (mäßiges Rauschen) | Kamera roh | 2 143 698 B | 62,0 s | 96 469 B 982×655 | 31,33 dB | 28,20 dB |
| | Handy 1600 / 0,85 | 409 092 B | 29,7 s | 94 426 B 982×655 | 30,93 dB | 27,89 dB |
| | Desktop 800 / 0,7 | 80 535 B | 1,18 s | 95 102 B 800×533 | 27,57 dB | 26,16 dB |
| | gespeicherte Form erneut | 95 102 B | 0,27 s | Byte für Byte gleich | — | — |

Release (Bench): Kamera 3000×2000 969 ms, 1600-px-Fassung 1 609 ms, 800-px-Fassung 72 ms (Hauptbild; Vorschau 292 / 80 / 24 ms),
Rauschen-Obergrenze 4 279 ms. Debug ist damit 16–68× langsamer als Release. Eine stärker verrauschte Kamera-Vorlage (Rauschen
±36 bzw. ±60) kam im Debug-Build zweimal nicht innerhalb von 3 bzw. 20 min durch den Normalisierer (Protokolle im Anhang) — die
Obergrenze ist deshalb nur als Release-Wert belegt.

**Der ursprüngliche 504 neu eingeordnet:** im ersten Bildlauf rechnete der Primary zwei ROHE Kamerafotos beim Abholen, im
Debug-Build — gemessen ~62 s je Foto. Die 20 s eines normalen Befehls konnten dabei nicht halten. Im Release wären es ~2 × 1 s.
Der 504 war also ein Debug-Artefakt des Rückfallwegs (Primary rechnet) und **begründet die 800 px nicht**. Die Befehlsphasen am
selben Programm (Debug, kleine Datenbank; „fertig" = die Wirkung steht in der Datei):

| Befehl | Ablegen je Foto (vor dem Befehl) | Antwort | fertig |
|---|---|---|---|
| Reparatur, 2 **rohe** Kamerafotos (der ursprüngliche 504: der Primary rechnet beim Abholen) | 62,1 s | **504 nach 20,0 s** | **124,8 s** (≈ 2 × 62 s Normalisieren + Speichern; genau eine Reparatur) |
| Reparatur, 2 vornormalisierte 1600-px-Aufnahmen (PC2 rechnet vorher) | 2,4 / 2,1 s | 200 in 0,83 s | 0,84 s |
| Reparatur, 2 vornormalisierte 800-px-Aufnahmen | 1,2 / 1,0 s | 200 in 0,70 s | 0,71 s |
| Artikel, 8 × 800-px-Aufnahme (Medienspeicher: Primary rechnet Haupt + Vorschau IM Befehl) | — | 504 nach 20,0 s | 21,1 s |
| Artikel, 8 × 1600-px-Aufnahme | — | 504 nach 20,0 s | 405,6 s |

Die Phasen des 504 sind damit gemessen, nicht aus Einzelzeiten abgeleitet: ~124 s Normalisieren im Befehl gegen 20 s Frist.
Mit vornormalisierten Fotos (heutiger Weg) liegt dieselbe Reparatur bei 0,7–0,8 s, gleich welche Fassung. Im Debug-Build reißt
auch der 800-px-Artikel knapp (21,1 s); im Release (16–68× schneller) nicht — der 1600-px-Artikel (405,6 s Debug) ist der Fall,
den § „Was die 800 px tatsächlich begründet" beschreibt.

**Was die 800 px tatsächlich begründet (Release-Zahlen):** die Aufnahme (`ImageUpload`) ist für Belegbilder UND Artikelbilder
dieselbe. Artikelbilder vom zweiten Rechner reisen roh und werden IM Befehl am Primary normalisiert (Hauptbild + Vorschau,
Medienspeicher): 8 Fotos × (1 609 + 80) ms ≈ 13,5 s bei 1600 px gegen 8 × (72 + 24) ms ≈ 0,8 s bei 800 px — und dazu 2 + 8
Ganz-DB-Speicherungen (§ 8). Mit 1600 px bleibt einem Artikel mit 8 Fotos schon bei kleiner Datenbank kaum Luft (≈ 13,5 s
Bilder + 10 × ~0,1 s Speichern ≈ 14,5 s von 20 s); mit 800 px sind es ≈ 1,8 s. Ab einigen hundert MB reißen die Speicherungen
die Frist bei beiden Fassungen (§ 8, F3) — die Aufnahmegröße ist dort nicht mehr der Engpass. Belegbilder rechnet
der aufnehmende Rechner VOR der Frist; dort kosten 1600 px ~1,6 s Wartezeit je Foto am aufnehmenden Rechner (6 Reparaturfotos ≈
10 s). Das Handy darf 1600 px: seine Fotos werden beim Abholen bzw. im Drain gerechnet, ohne Brückenfrist, und seine Aufnahme ist
die Vorlage der KI-Erkennung.

**Was die 800 px kosten (gemessen):** bei gleicher Grenze (≤ 100 000 B) ist das gespeicherte Belegbild 800×533 statt 982×655
und 3,4 dB schlechter in der 800-px-Anzeige (1,7 dB in der 1600-px-Anzeige): die 800-px-Aufnahme wird vom Normalisierer ein
zweites Mal kodiert (q0,7 → Qualitätsleiter ab 85, Generationsverlust), die 1600-px-Aufnahme nur einmal verkleinert.
Entscheidung: 800 px bleiben (gemeinsame Aufnahme, Frist des Artikelwegs). Ein eigenes 1600-px-Profil nur für Belegbilder
(Rechenzeit am aufnehmenden Rechner, keine Frist) wäre möglich — das ist eine Produktentscheidung und hier nicht umgesetzt.

## 5. Fristen: Beginn, Ende, Schlange, weiterlaufende Mutation, Wiederholung

- **Beginn:** `command_execute` liest den HTTP-Rumpf, prüft Anmeldung und Kennung, rechnet `timeout_for(op, payload, db_bytes)`;
  die Frist beginnt in `Bridge::dispatch` mit der Zustellung ans Fenster (`tokio::time::timeout(timeout, rx)`). Das Senden des
  Rumpfs (bei 33 MB Base64 spürbar) liegt davor und zählt nicht.
- **Ende:** die Antwort `bridge_reply` — der Renderer sendet sie erst nach `runRemoteCommand`: Transaktion, Commit, Kennungsnachweis
  in derselben Transaktion, `ensureDurable` (ganze DB). Frist ≠ Erfolg: bei Ablauf 504 `BRIDGE_TIMEOUT`, Ausgang **unknown**.
- **Schlange:** die Zustellung reiht den Auftrag in die EINE Schreibreihenfolge (`runExclusive`, FIFO). Wartezeit hinter anderen
  Aufträgen — dem Selbst-Abgleich (bis 2 Ganz-DB-Speicherungen), einer Texterkennung, dem Normalisieren abgeholter Handyfotos —
  **verbraucht die Frist**; die Formel hat dafür keinen Anteil. Gemessen (Baseline, 518 MB): kleiner Upload 504 nach 20 s, fertig
  nach 42 s; HEAD mit abgeleiteter Upload-Frist: 200 nach 40,3 s bzw. 42,5 s.
- **Nach Ablauf läuft die Mutation weiter:** Rust nimmt den Wartenden heraus (`take_pending`), der Renderer arbeitet den Auftrag zu
  Ende, committet, speichert durabel; seine Antwort findet niemanden (`reply not delivered`). Die Wirkung kann also schon
  gespeichert sein — genau das sagt `unknown`.
- **Wiederholungssicherheit (bestehend):** dieselbe `commandId` mit derselben Identität wird angenommen (`IdentityStore::begin`,
  `in_flight`), wartet in der Schreibreihenfolge hinter dem ersten Lauf und findet dessen Nachweis in der Transaktion
  (`lookupCommand` → `replay`) → das eingefrorene Ergebnis, keine zweite Wirkung; dieselbe Kennung für etwas anderes →
  `BRIDGE_COMMAND_ID_CONFLICT`. Belege: `test/bridge/write-foundation` (Nachweis/Replay, `CENTRAL_C3_…_PROVED`),
  `remote-invoice-create` 131/0, `service-documents` 167/0 (jetzt gelaufen); E2E `r7b-pp12-images` (dieselbe Kennung → dieselbe
  Reparatur, genau eine), `r7b-pp12-large-db` (jede Wirkung genau einmal, auch nach 504). Offen bleibt: eine Ergebnisabfrage
  ohne erneutes Senden gibt es nicht.

## 6. Persistenz: „kein fsync" gegen den Vertrag

Vollständiger Speicherpfad der Geschäftsdatenbank: `saveDatabaseDurably` → Save-Coalescer (ein Schreiben gleichzeitig) →
`db.export()` → `persistDb` → `atomicWrite`: SQLite-Kopfprüfung → Stale-Guard (Größe + mtime) → `plugin:fs|write_file`
(`tauri-plugin-fs 2.5.0` `write_file_inner`: `OpenOptions` + `write_all`, **kein `sync_all`**) → Größenprüfung der Temp-Datei →
`plugin:fs|rename` (`std::fs::rename` = `MoveFileExW(REPLACE_EXISTING)`, **ohne `WRITE_THROUGH`**) → neue Signatur.
Der Vertrag im Code (`saveDatabaseDurably`, M2): „dauerhaft auf die aktive DB-Datei geschrieben". Einordnung:

- **Neustartfest: ja.** Nach dem Umbenennen steht der neue Stand vollständig im Dateisystem (Seiten-Cache des Betriebssystems);
  ein Absturz der Anwendung, ein regulärer oder erzwungener Prozess-Exit ändern daran nichts — der nächste Start liest genau diese
  Datei (so belegt in jedem Neustart-Nachweis: Beenden → Neustart → alles da). Die Temp-Datei schützt gegen einen abgebrochenen
  Schreibvorgang: die alte Datei bleibt bis zum Umbenennen unberührt.
- **Stromausfall-/Betriebssystemabsturz-fest: nein.** Ohne `FlushFileBuffers` kann das Umbenennen (Metadaten, im NTFS-Journal)
  vor den Datenseiten auf der Platte stehen. Fällt der Strom in diesem Fenster (typ. Sekunden nach jedem Speichern), kann die
  Datei alt, leer oder beschädigt sein. Erkennung: der Start weist eine nicht lesbare Datenbank ab (`DB_RECOVERY_REQUIRED`,
  C6-P1) statt einen leeren Bestand anzulegen; eine beschädigte, aber lesbare Seite würde nicht erkannt (keine
  `integrity_check` beim Start). Rettung: Sicherung. Rusts eigene Dateien (Medienspeicher, Datenort, Staging, Journale) rufen
  `sync_all` (+ Verzeichnis-Sync); nur die Geschäftsdatenbank nicht — nach einem Stromausfall können Mediendateien also neuer sein
  als die Datenbank (verwaist → Aufräumen mit Quarantäne).
- Nicht geändert (Umfang: kein allgemeiner Speicherumbau). Ein `fsync` bräuchte einen eigenen Rust-Befehl (Temp schreiben +
  `sync_all` + Umbenennen + Verzeichnis-Sync) und kostet bei 500 MB zusätzliche Sekunden je Speichern.

## 7. PP-12 — Frist nach der echten Speicherung (unverändert seit `1479b09`)

```
upload   = 20 s + min(len, 32 MiB) × 10 / 10 MB/s  +  (db_bytes + 2 × len) / 4 MB/s
set_ocr  = 20 s + 10 s + 12 MP / 0,2 MP/s          +  db_bytes / 4 MB/s
content  = 20 s + 32 MiB × 4 / 10 MB/s             (liest nur, speichert nichts)
sonst    = 20 s
```

`db_bytes` = Größe von `lataif.db` am Primary im Moment der Anfrage (`routes.rs` `command_execute`). Nachweis
`r7b-pp12-large-db` 13/0:

| DB bei der Anfrage | normaler Befehl (20 s) | größtes Dokument fertig / Frist | alte Frist | Texterkennung fertig / Frist |
|---|---|---|---|---|
| 2 MB | 0,1 s | 17,8 / 70,6 s | 53,5 s | 2,9 / 107,2 s (69 MB) |
| 203 MB | 5,3 s | 21,9 / 121,0 s | 53,5 s | 7,5 / 157,5 s (270 MB) |
| 451 MB | 10,7 s | 27,8 / 182,9 s | 53,5 s | 13,4 / 219,5 s (518 MB) |

Mit laufendem Selbst-Abgleich (dieser Nachtrag, 518 MB): größtes Dokument 42,6 s bei Frist 182,9 s → 200; mit der alten Frist
(Baseline) 504 nach 30,2 s, fertig nach 30,8 s.

## 8. Skalierungsbefund normale Befehle (G5) und Handy-Drain (F2)

Jeder schreibende Befehl speichert die ganze Datenbank (`db.export()` + Schreiben): gemessen 0,1 s (2 MB), 5,3 s (203 MB),
10,6–12,7 s (451 MB). Die Frist normaler Befehle bleibt 20 s — bei ~450 MB ist die Hälfte davon Speichern; eine Wartezeit hinter
dem Selbst-Abgleich (bis 2 × 13 s bei 518 MB) reißt sie (504 `unknown`, Wirkung genau einmal, s. § 5). Das ist ein
Skalierungsbefund des Ganz-Datenbank-Speicherns, kein Fehler einzelner Wege; daraus werden hier weder eine pauschale
Fristerhöhung noch ein Speicherumbau abgeleitet (eigene Entscheidung). F2: die Drain-Lease (120 s) wird nie verlängert; mit
2 + N Ganz-DB-Speicherungen je Handy-Auftrag kann sie bei großer DB ablaufen (`ready_rejected`), der nächste Lauf nimmt den Auftrag
über die Quittung wieder auf — unverändert.

## 9. Rust `legacy_push_tests::o1_o5_o10_operation_matrix_enforced_for_every_table`

Rot an HEAD: `(52, 36, 37)` gegen erwartet `(50, 36, 37)` (`cargo test --lib o1_o5_o10`). Herleitung aus dem kanonischen
Manifest `src/core/sync/sync-business-schema.json` (`allowed_operations` gezählt je Stand):

| Stand | Tabellen | insert / update / delete |
|---|---|---|
| `663c2d7` (Test gesetzt) … `be76e50` | 50 | 50 / 36 / 37 — grün |
| `ab7f169` (R6F: `sales_returns`, `sales_return_lines` ohne `delete`) | 50 | 50 / 36 / **35** — rot seit hier |
| `aaa14d9` (R7A PP-10: `production_inputs`/`_outputs` insert+delete) … `d988810` … HEAD | 52 | **52** / 36 / 37 — rot |

Der TS-Drift-Gate (`test/m6b3a/manifest-drift.test.ts`) pinnt denselben Vertrag bereits mit 52/36/37 und derselben Begründung;
der Rust-Pin wurde beide Male nicht mitgeführt. Korrektur: `(52, 36, 37)` + Herleitung im Kommentar. Kein Manifest geändert.
`cargo test --lib sync::routes` **74/0**.

## 10. Bestandsaufnahme aller Bild-Uploads — Vorher / Nachher (aktualisiert)

| # | Einstieg | Speicherort | vorher | nachher |
|---|---|---|---|---|
| A/B | Handy Collection anlegen / Galerie / Text | Medienspeicher | 100 000 / 20 000 B hart (`ingest.prepare`) | unverändert |
| C/K | KI-Erkennen (Handy, Desktop, PC2) | nichts gespeichert | Transportgrenzen | unverändert |
| D | **Handy Reparatur, Einkaufs-Inbox** | `repairs.images`, `purchase_inbox.images` | keine Byte-Grenze | **≤ 100 000 B bei der Übernahme**, gespeicherte unverändert, Umweg → Quarantäne |
| E | Desktop/PC2 Artikel, Kommission, Fertigung | Medienspeicher | hart, Aufnahme 800 px | unverändert |
| F | Einkauf „New Item" (auch aus Inbox) | `products.images` | ≤ 100 000 B (PP-12), keine Vorschau | **Medienspeicher** (Hauptbild + Vorschau) nach dem Commit |
| G | Auftrag „New Item" / Sonderstück (Artikel) | `products.images`; Entwurf `orders.custom_product_spec` | ≤ 100 000 B | Artikel **Medienspeicher**; der Entwurf bleibt Belegbild ≤ 100 000 B |
| H/I/J | Reparatur, Altgold, Ausweis (Desktop/PC2) | Zeile | ≤ 100 000 B (PP-12) | unverändert |
| X | **jede Bildspalte über `/api/sync/push`** | Zeile | wörtlich | **normalisiert bei der Übernahme** |
| L | Dokumente | `documents.file_path` (Original) | ≤ 25 116 672 B | **unverändert** (Original = OCR-Vorlage), Frist nach DB-Größe |

## 11. Tests und Nachweise (zum finalen Code)

Alle Läufe gegen den finalen Code (E2E-Programme nach dem letzten Codecommit neu gebaut: Primary + PC2-Client, Debug, isoliert
`com.lataif.app.e2e`, Port 3011; Produktion, `E:\LATAIF\Data`, 3001/3443 unberührt, jede fremde `lataif.exe` geprüft). Die
vollständigen Ausgaben stehen im Anhang `pp12-closure-test-outputs.log`.

**Einheitstests (Node), neu:** `pp12-close-budget` 19/0, `pp12-pulled-images` 26/0, `pp12-new-item-media` 17/0.
**Nachbarn** (von den Änderungen berührt): `pp12-images` 56/0, `m4 window-close-persistence` 50/50, `m5 reload-persistence` 30/30,
`post-release-shutdown relaunch-coordinator` 28/28, `mobile04b2a12u1 restore-wiring` 15/0, `mobile04b2a12u2 backup-workflow` 20/0,
`media04b2a2 drain-handoff` 94/0, `consignment duplicate-single-create` 34/0, `sku-desktop-unify` 60/0, `sync cursor-safety` 120/0,
`m2 mobile-sync-durable-cursor` 46/46, `c6 release-hardening` 38/0, `storage-perf sync-payload-contract` 18/0,
`m6b3a manifest-drift` 1475/1475, `r6f order-parity` 253/0, `r6d metal-scrap-parity` 253/0, `r6c masterdata-parity` 89/0,
`bridge write-foundation` (PROVED), `remote-invoice-create` 131/0, `service-documents` 167/0, `r7b-platform-hardening` 111/0,
SSOT-Gates `r6c/r6d/r6e/r6f final-gate`, `r6b safety`, `r5e order-contract-pins` (Anhang). Typcheck `tsc -b` grün. Lint: keine
neuen Fehler (Fehlerzahl je geänderter Datei = HEAD; neue Dateien 0).
**Rust:** `cargo test --lib sync::routes` **74/0** (inkl. `o1_o5_o10`), `media::record_image` (Anhang).
**E2E (HEAD, final):** `r7b-pp12-shutdown` **14/0**, `r7b-pp12-mobile-takeover` **20/0**, `r7b-pp12-images` **22/0**.
**Nachstellungen / Baseline** (temporäre Skripte, nicht eingecheckt; Protokolle im Anhang): HEAD vorher 1–4 (§ 1),
Baseline `d988810` ohne und mit laufendem Abgleich (§ 1), Messung Aufnahmeprofil (§ 4).
Nicht wiederholt (unverändert, gültige Nachweise): `r7b-pp12-large-db` 13/0 (Fristen der Dokumentwege; nur ein Kommentar
aktualisiert).

## 12. Git

Folgecommits auf `0a15565` (kein Amend, kein Push/Tag/Release):

1. `30ec48e` — Rust: `legacy_push … o1_o5_o10` Erwartung aus dem kanonischen Manifest (52/36/37).
2. `025434f` — Beenden/Neuladen/Neustart: Wartefristen nach Datenbankgröße (`relaunch-coordinator.ts`, `database.ts`, alle
   Wartepunkte) + `pp12-close-budget`.
3. `44e83ce` — Fotos aus dem Abgleich bei der Übernahme normalisiert (`pulled-record-images.ts`, `sync-service.ts`) +
   `pp12-pulled-images`.
4. `82d35f3` — „New Item"-Artikel in den Medienspeicher (`new-item-media.ts`, `productStore.ts`) + `pp12-new-item-media`,
   Bildlauf-Erwartung.
5. `fa4676a` — Folgecommit: das Leeren von `products.images` wird erfasst (Echo-fest).
6. dieser Commit — E2E `r7b-pp12-shutdown`, `r7b-pp12-mobile-takeover`, Kommentar `r7b-pp12-large-db`, dieses Review, SSOT.

Version 0.8.54 und Registry 175 unverändert (keine technische Notwendigkeit).
