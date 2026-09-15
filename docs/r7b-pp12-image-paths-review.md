# R7B / PP-12 — Bildwege, Frist nach der echten Speicherung, reguläres Beenden

Stand 15.09.2026 (Abschlussprüfung, Nachtrag + Belegpaket) · Basis `0a15565` (PP-12-Abschluss) auf `243e4e6`, Baseline des
Pakets `d988810` · Version 0.8.54 ·
Registry 175 (unverändert) · kein Push/Tag/Release. PP-3 … PP-7 gelten als geschlossen und wurden nicht angefasst.

## 0. Status je Punkt (jeder mit eigenem Beleg; keine Sammel-Aussage)

**Freigabestatus (getrennt geführt):**

| Stufe | Stand |
|---|---|
| technisch freigegeben | **ja** — `R7B_TECHNICAL_REVIEW_APPROVED_FCA07B1`, unabhängige Prüfung des Quellstands `fca07b1e33929f972d7c66c8ca22789f8f7ab3bc` (drei Nachforderungen zu `19ac2da` + korrigierte Meldung, § 13, § 14) |
| lokal committed | ja — `main`, Freigabe-Doku als reiner Doku-Folgecommit auf `fca07b1` |
| gepusht | **nein** |
| released | **nein** (Version 0.8.54, Registry 175 unverändert, kein Tag) |
| offen, nicht akzeptiert | R1, R2, R3, R4, G5 (Tabelle unten) |

| Punkt | Status | Beleg (Einzelheiten im Abschnitt) |
|---|---|---|
| **PP-12 Frist der Dokumentwege** (DB-Größe + Wachstum, normale Befehle 20 s) | **geschlossen** (unverändert seit `1479b09`) | § 7; `r7b-pp12-large-db` 13/0 (bis 451/518 MB) |
| **F4 Reguläres Beenden bei großer DB** | **behoben** — Ursache gefunden, vorbestehend (Baseline `d988810`) | § 1; Nachstellung HEAD vorher + Baseline hängen, `r7b-pp12-shutdown` **14/0** (518 MB, Abgleich unterwegs: endet nach 23,9 s) |
| **G2 Handy-Reparatur / Einkaufs-Inbox ohne Byte-Grenze** | **behoben** — Normalisierung bei der Übernahme (Abholen), Umweg → Quarantäne | § 2; `pp12-pulled-images` 26/0, `r7b-pp12-mobile-takeover` **20/0** |
| **G3 Artikelbilder in `products.images`** (Einkauf/Auftrag „New Item") | **zusammengeführt** — derselbe Cutover-Dienst wie beim Bearbeiten: Medienspeicher + Vorschau nach dem Commit | § 3; `pp12-new-item-media` 17/0, Mobile-Lauf 20/0, `r7b-pp12-images` **22/0** |
| Verbliebene `products.images`-Schreiber | **begründet** (kein neues Foto / Migration / Abgleich-Transport) | § 3 Tabelle |
| **G7 Aufnahmeprofil 800 px (Desktop) vs. 1600 px (Handy)** | **gemessen begründet — Release** (Artikelweg 8 Aufnahmen, Belegweg; Bytes Debug = Release, damit gilt die Qualitätsmessung); der ursprüngliche 504 als Debug-Artefakt erklärt; kein neues Profil | § 4 |
| **G4 Keine Vorschau für Belegbilder** | begründet, unverändert (Vorschau gibt es nur, wo ein Medienspeicher-Objekt entsteht) | § 2 |
| **G6 Timeout / Wiederholung derselben Kennung** | **belegt am Callpath**: während des ersten Laufs, nach 504, nach Commit bei verlorener Antwort, nach Neustart → genau eine Wirkung (Replay); Wartezeit in der Schreibreihenfolge zählt gegen die Frist (SSOT korrigiert). Keine neue Ergebnis-API nötig. Offen ausgewiesen: R1–R3 | § 5 |
| **F2 Handy-Drain-Lease** | **belegt**: 120 s je Auftrag, Token-Besitz; Ablauf WÄHREND der Übernahme gezielt getestet (`drain-handoff` §20 neu, 106/0): alter Besitzer `ready_rejected`, ein Produkt, nichts verloren. Frühere Aussage „läuft bei großer DB ab → `ready_rejected`" korrigiert | § 5a |
| **F1 Persistenz** | **getrennt eingeordnet (Review `19ac2da` nachgeschärft)**: regulärer Neustart durch die vorhandenen Neustart-Nachweise belegt; Stromausfall-Dauerhaftigkeit nach der Speicherbestätigung **nicht garantiert**; eine feste zeitliche Obergrenze des Risikofensters ist nicht belegt (die unbelegte Fassung „fest nach einigen Sekunden" ist zurückgenommen). Vorbestehend seit `88e1199`, nicht geändert. Offen ausgewiesen: R4 | § 6 |
| **PP-5 Sitzungsablauf** (Review `19ac2da`) | **behoben**: `verifyStoredSession` prüft `sessions.expires_at` der eigenen DB (abgelaufen, unlesbar, leer → verworfen); eine scheiternde Prüfung verwirft die Sitzung, auch der Fang in `App.tsx` | § 13.1; `r7b-platform-hardening` **118/0** |
| **PP-12 ungültige Bildformen** (Review `19ac2da`) | **behoben**: nachgelagert prüft die Übernahme nur die Transportform (belegt); jetzt gemischte Liste, Objekt statt Liste, Nicht-Text bei `cpr_image`, Entwurf ohne gültige Fotoliste → Quarantäne `RECORD_IMAGE_SHAPE_INVALID`; leere Felder und unveränderte Bestandswerte bleiben | § 13.2; `pp12-pulled-images` **32/0** |
| **Meldung bei offenem Ausgang** (Review `19ac2da`) | **korrigiert**: kein absolutes „it can never happen twice" mehr; die Wiederholung gilt aus derselben Maske, nach Verlassen/Neuladen erst nachsehen (R1 bleibt offen) | § 13.4 |
| **G5 Normale Befehle 10,7 s bei 451 MB** | **Skalierungsbefund**, offen (keine pauschale Fristerhöhung, kein Speicherumbau) | § 8 |
| **Rust `legacy_push_tests::o1_o5_o10`** | **behoben** — Erwartung aus dem kanonischen Manifest (52/36/37), vorbestehend rot seit `ab7f169` | § 9 |

**Bestätigte Restbefunde (offen, mit Auswirkung und Scope; alle vorbestehend, keiner aus PP-12, keiner mit Doppelwirkung am
Protokoll):**

| # | Befund | Auswirkung | Scope |
|---|---|---|---|
| R1 | Die offene Vorgangskennung lebt nur im Speicher der PC2-Maske | wird die Maske nach „keine Antwort" verlassen oder PC2 neu geladen und der Vorgang neu erfasst, entsteht eine zweite Wirkung, falls der erste Lauf committet hatte | alle Fernschreibwege von PC2 (§ 5) |
| R2 | Nach „keine Antwort" + geändertem Formular antwortet der Primary 409 `not_executed`; der Versuch bleibt absichtlich offen | jeder weitere Klick bekommt denselben Konflikt, bis das Formular zurückgesetzt oder die Maske verlassen wird (dann R1) | PC2-Masken (§ 5) |
| R3 | Konflikt nach Verdrängung der Kennung aus Rust (> 1024 neuere) oder nach Neustart: Renderer antwortet 500 ohne `outcome` | PC2 zeigt „unbekannt" statt „nicht ausgeführt"; keine Wirkung | Fernbefehle (§ 5) |
| R4 | Eine 0-Byte-`lataif.db` öffnet als LEERE Datenbank statt `DB_RECOVERY_REQUIRED` | nach einem Stromausfall/Absturz kurz nach einem Speichern (oder einem Eingriff von außen) startet die App leer, ohne Wiederherstellungshinweis | Start des Primary (§ 6) |
| G5 | Ganz-DB-Speichern skaliert mit der Dateigröße | normale Befehle bei ~450 MB zur Hälfte Speichern; mit belegter Schlange 504 `unknown` (Wirkung genau einmal) | alle schreibenden Befehle (§ 8) |

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
Vorlage in der Anzeigegröße 800×533 und 1600×1067. Die Zeiten DIESER Tabelle sind Debug (Fenster des E2E-Programms); die
Begründung weiter unten stützt sich allein auf die Release-Messung.

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

**Release-Messung an HEAD** (`bench_capture_profile`, `record_image.rs`, `#[ignore]`, in diesem Paket ergänzt; je Fassung 8
verschiedene fotoähnliche Aufnahmen mit APP1-Segment — also nicht die gespeicherte Form, sie werden gerechnet wie die
Desktop-Aufnahme im Fenster; jeder Weg als Stapel gemessen, nicht aus Einzelzeiten addiert; 3 Läufe einzeln, Anhang
`release-bench_capture-profile_*.log`):

| Weg | 800 px / q0,7 | 1600 px / q0,85 |
|---|---|---|
| **Artikel** am Primary IM Befehl: 8 × (Hauptbild + Vorschau), genau `ingest.rs` (rechnet jedes Foto) | **0,85–0,89 s** (105–111 ms/Foto); Hauptbild ≤ 99 630 B 800×533, Vorschau ≤ 18 088 B | **13,7–13,9 s** (1,72–1,74 s/Foto); Hauptbild ≤ 99 245 B 1156×771, Vorschau ≤ 13 447 B |
| **Belegbild** am aufnehmenden Rechner (`normalize_record_image`) | 78–80 ms/Foto → 800×533 | 1,60–1,62 s/Foto → 1156×771 |
| dieselben Aufnahmen im Debug-Build (1 Lauf) | Artikel 15,6 s, Beleg 1,0 s/Foto | Artikel 214,5 s, Beleg 23,8 s/Foto |
| Hash der Ausgabe, Debug = Release | `8070da3411b8` / `86e6c63024db` | `acb1c21c4ffe` / `2328372988e8` |

Debug ist auf diesen Wegen 15–18× langsamer. Die Ausgaben sind in beiden Builds Byte für Byte gleich — die im Fenster (Debug)
gemessene Bildqualität gilt damit für Release. Obergrenze (Rauschen 3000×2000, `bench_normalize_times`, 3 Läufe an `3035f49`):
4,30–4,34 s Hauptbild + 0,49–0,50 s Vorschau; Kamera 3000×2000: 0,99–1,03 s. In `bench_normalize_times` läuft die synthetische
800-px-Aufnahme OHNE Metadaten als gespeicherte Form durch (5–9 ms, Byte für Byte) — so verhält sich nur der Belegweg; der
Artikelweg rechnet jedes Foto. Die früher zitierten „72 ms" stammen aus einem Zwischenstand von `record_image.rs` vor dem Commit
`02c976b` und sind ersetzt. Eine stärker verrauschte Kamera-Vorlage (Rauschen ±36 bzw. ±60) kam im Debug-Build zweimal nicht
innerhalb von 3 bzw. 20 min durch den Normalisierer (Protokolle im Anhang) — die Obergrenze ist deshalb nur als Release-Wert
belegt.

**Der ursprüngliche 504 neu eingeordnet:** im ersten Bildlauf rechnete der Primary zwei ROHE Kamerafotos beim Abholen, im
Debug-Build — gemessen ~62 s je Foto. Die 20 s eines normalen Befehls konnten dabei nicht halten. Im Release sind es
~2 × 1 s (Kamera 3000×2000: 0,99–1,03 s).
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
auch der 800-px-Artikel knapp (21,1 s); im Release (Artikelweg gemessen 0,85–0,89 s für 8 Aufnahmen) nicht — der
1600-px-Artikel (405,6 s Debug, 13,7–13,9 s Release) ist der Fall, den der folgende Absatz beschreibt.

**Was die 800 px begründet (nur Release-Messung):** die Aufnahme (`ImageUpload`, `capture-profile.ts`) ist für Beleg- UND
Artikelbilder dieselbe. Artikelbilder vom zweiten Rechner reisen roh und werden IM Befehl am Primary gerechnet (Hauptbild +
Vorschau). Gemessen für einen Artikel mit 8 Aufnahmen: **13,7–13,9 s bei 1600 px gegen 0,85–0,89 s bei 800 px** — dazu 2 + 8
Ganz-DB-Speicherungen (bei kleiner Datenbank je ~0,1 s, § 8) und jede Wartezeit in der Schreibreihenfolge, die gegen die Frist
zählt (§ 5). Mit 1600 px bleiben von 20 s schon bei kleiner Datenbank ~5 s für Speichern und Schlange — ein laufender
Selbst-Abgleich (2 Ganz-DB-Speicherungen) oder eine wachsende Datei reißt die Frist (504 `unknown`); mit 800 px bleiben ~18 s. Ab
einigen hundert MB reißen die Speicherungen die Frist bei beiden Fassungen (§ 8, G5) — dort ist die Aufnahmegröße nicht mehr
der Engpass. Belegbilder rechnet der aufnehmende Rechner VOR der Frist: 1600 px kosten dort 1,60–1,62 s Wartezeit je Foto
(6 Reparaturfotos ≈ 9,7 s) gegen 78–80 ms. Das Handy darf 1600 px: seine Fotos werden beim Abholen bzw. im Drain gerechnet,
ohne Brückenfrist (Drain: gegen die Lease läuft nur das Vorbereiten, ≤ 8 × ~1,7 s ≪ 120 s, § 5a), und seine Aufnahme ist die
Vorlage der KI-Erkennung.

**Was die 800 px kosten (gemessen):** bei gleicher Grenze (≤ 100 000 B) ist das gespeicherte Belegbild 800×533 statt 982×655
und 3,4 dB schlechter in der 800-px-Anzeige (1,7 dB in der 1600-px-Anzeige): die 800-px-Aufnahme wird vom Normalisierer ein
zweites Mal kodiert (q0,7 → Qualitätsleiter ab 85, Generationsverlust), die 1600-px-Aufnahme nur einmal verkleinert.
Entscheidung: 800 px bleiben (gemeinsame Aufnahme, Frist des Artikelwegs). Ein eigenes 1600-px-Profil nur für Belegbilder
(Rechenzeit am aufnehmenden Rechner, keine Frist) wäre möglich — das ist eine Produktentscheidung und wird für diesen Abschluss
ausdrücklich nicht eingeführt.

## 5. Timeout und Wiederholung derselben Vorgangskennung (tatsächliche Callpaths)

**Weg** (Stand HEAD): PC2 `CommandSaveAttempt.send` (`client-command-save.ts`) → `POST /api/command` → `routes.rs`
`command_execute` (Rumpf, Anmeldung, Identität, `timeout_for(op, payload, db_bytes)`) → `Bridge::submit_as` →
`IdentityStore::begin` (`bridge.rs:792-806`) → `Bridge::dispatch` (`bridge.rs:978-1005`: je Zustellung eine frische `op_id`,
eigener `pending`-Eintrag, `sink.deliver`, `tokio::time::timeout(timeout, rx)`) → Renderer `bridge-listener` →
`command-registry.ts:238` `runExclusive(handler)` (EINE Schreibreihenfolge, FIFO) → `runRemoteCommand` (`mutation-engine.ts`:
BEGIN, `lookupCommand` `:138`, Handler, `recordCommand` `:152` in DERSELBEN Transaktion wie die Wirkung, COMMIT, `ensureDurable`
`:213`) → `bridge_reply` → HTTP (`routes.rs:255-279`); danach `IdentityStore::finish` (`bridge.rs:935-938`).

- **Frist:** Beginn = Zustellung in `dispatch`; Ende = `bridge_reply`, gesendet erst nach `ensureDurable` (ganze DB). Das Senden
  des Rumpfs liegt davor und zählt nicht. **Die Wartezeit in `runExclusive` hinter anderen Aufträgen** (Selbst-Abgleich bis 2
  Ganz-DB-Speicherungen, Texterkennung, Normalisieren abgeholter Handyfotos) liegt zwischen Beginn und Ende und **zählt gegen die
  Frist**; die Formel (§ 7) hat dafür keinen Anteil. Frühere SSOT-Sätze, die sich anders lesen ließen, sind ausdrücklich
  korrigiert (`central-ui-parity.md`, R7B-Review „misst nur das Warten ab Übergabe an das Fenster" und PP-12 „die Frist enthält
  keine Wartezeit hinter anderen Aufträgen"). Gemessen (518 MB, Abgleich unterwegs): kleiner Upload Baseline 504 nach 20 s,
  fertig nach 42 s; HEAD mit abgeleiteter Upload-Frist 200 nach 40,3–42,5 s.
- **Frist ≠ Erfolg:** bei Ablauf 504 `BRIDGE_TIMEOUT`, `outcome: unknown`; Rust nimmt nur den Wartenden heraus (`take_pending`),
  der Renderer arbeitet den Auftrag zu Ende, committet, speichert; seine Antwort findet niemanden (No-op).

| Fall | Verhalten am Callpath | Ergebnis | Beleg (vorhandene Tests) |
|---|---|---|---|
| **1** dieselbe Kennung + derselbe Rumpf, **während der erste Lauf noch arbeitet** | `begin`: gleiche Identität → `in_flight += 1`, **zweite Zustellung** mit eigener `op_id` (der erste Wartende wird weder überschrieben noch übernommen); im Renderer wartet sie in `runExclusive` hinter dem ersten; ihr `lookupCommand` findet dessen Nachweis → `replay` | 200, eingefrorenes Ergebnis + `replayed: true`, **keine zweite Wirkung**; dauert der erste länger als die Frist der Wiederholung, auch hier 504 `unknown` — weiter ohne zweite Wirkung | Rust `bridge_tests`: `the_same_id_with_the_same_payload_is_a_retry`, `a_running_command_is_never_evicted`; E2E `c5-operational-acceptance` CONC-MONEY (zwei gleichzeitige Sendungen derselben Kennung: genau 30 gebucht, eine Zahlungszeile) |
| **1b** dieselbe Kennung, **anderer Rumpf**, solange Rust sie kennt | `begin` → `CommandIdConflict` VOR der Zustellung | 409 `BRIDGE_COMMAND_ID_CONFLICT`, `outcome: not_executed` | `the_same_id_with_a_different_payload_is_refused_before_dispatch`, `a_changed_identity_still_conflicts_even_with_the_same_payload`, `within_the_retention_a_changed_payload_still_conflicts` |
| **2** erster Lauf in Rust **abgelaufen (504)**, Renderer arbeitet weiter | `finish` senkt nur `in_flight`, die Kennung bleibt gemerkt (bis 1024 neuere, laufende nie verdrängt); Wiederholung wie Fall 1 | Replay, keine zweite Wirkung | `silence_ends_in_a_bounded_failure_and_leaves_nothing_behind`, `a_reply_nobody_waits_for_changes_nothing`, `a_lost_reply_is_unknown_not_failed`, `the_identity_store_stays_bounded`; `write-foundation` RETRY |
| **3** **committet und durabel, Antwort verloren** (504, Verbindung) | Nachweis `remote_command_ledger` (PK `command_id`) in derselben Transaktion; `lookupCommand` vergleicht Mandant, Filiale, Benutzer, op, `payloadHash` (`command-ledger.ts:92-121`) | `completed` → 200, dasselbe Ergebnis + `replayed: true`; ein eingefrorenes fachliches Nein → wieder dasselbe 409 | `write-foundation` RETRY/CONFLICT; `remote-invoice-create` RETRY (keine zweite Bestands-/Hauptbuchbuchung), PERSIST (Speichern scheiterte → die Wiederholung begleicht zuerst die Speicherschuld, dann Replay); E2E `r7b-platform-hardening` LOST (erste Antwort verworfen, der Primary HAT ausgeführt, die Wiederholung bekommt dieselbe Wirkung) |
| **4** Primary **neu gestartet** | `IdentityStore` (Speicher) ist weg, der Nachweis liegt in `lataif.db` → Replay über `lookupCommand`; starb der Prozess zwischen COMMIT und Speichern, fehlen Wirkung UND Nachweis gemeinsam → die Wiederholung läuft genau einmal (`fresh`) | genau eine Wirkung | `write-foundation` RESTART A/B, `remote-invoice-create` RESTART |
| **5** PC2 | kein automatisches Wiederholen (ein `fetch` je Klick); `CommandSaveController.beginAttempt` gibt bei offenem Versuch DIESELBE Kennung aus, erst eine beantwortete Anfrage schließt ihn | die Wiederholung ist der erneute Klick | `remote-invoice-create` CLIENT, `r4b-write-adapter` |

**Ergebnis:** jede Kombination endet in genau einer Wirkung; die „Ergebnisabfrage" ist die Wiederholung selbst (Replay). Eine
neue Ergebnis-API ist für die Wiederholungssicherheit nicht nötig. Die Kette „Rust 504 → Renderer schließt ab → Wiederholung =
Replay" ist durch ihre Glieder belegt (Tabelle), nicht als ein E2E-Ablauf.

**Offen ausgewiesen (bestätigt am Code, vorbestehend, keine Doppelwirkung am Protokoll, nicht geändert):**
- **R1** Die offene Kennung lebt nur im Speicher der Maske (`shared-write.ts:128` `useMemo`, `:199` `useRef`). Verlässt der
  Benutzer nach „keine Antwort" die Maske oder lädt PC2 neu und erfasst den Vorgang erneut, bekommt er eine neue Kennung —
  hatte der erste Lauf committet, entsteht eine zweite Wirkung. Die Meldung sagt das seit dem Review von `19ac2da` ehrlich
  („on this form … If you leave this form or reload first, check whether it was saved", § 13.4). Behebung wäre eine dauerhafte
  offene Kennung je Maske (Produktentscheidung, nicht in diesem Auftrag).
- **R2** Der Rumpf wird bei jedem Klick neu gebaut. Nach „keine Antwort" + geändertem Formular antwortet der Primary 409
  `not_executed`; `send` gibt `not_executed` zurück, der Versuch bleibt absichtlich offen (der erste Ausgang ist weiter
  unbekannt) → jeder weitere Klick bekommt denselben Konflikt, bis das Formular zurückgesetzt oder die Maske verlassen wird.
- **R3** Nach Verdrängung der Kennung aus Rust (> 1024 neuere) oder nach Neustart meldet der Renderer den Konflikt als
  `CommandNotEvaluated` → 500 ohne `outcome`; PC2 zeigt „unbekannt" statt „nicht ausgeführt".

## 5a. Handy-Drain-Lease: Dauer, Geltung, Ablauf während der Übernahme

- **Dauer:** `MOBILE_DRAIN_LEASE_SECONDS = 120` (`mobile-upload-drain.ts:38`), beim Claim übergeben (`:820`); Rust klemmt auf
  1…3600 s (`lib.rs:2295-2296`). Nie verlängert (`renew` existiert, hat keinen Aufrufer).
- **Geltung:** je Handy-Auftrag (`mobile_upload_claim`, PK Mandant/Filiale/Benutzer/`upload_event_id`); Besitz = frisches
  `claim_token` je Claim.
- **Wo sie zählt:** beim Claim (ein `processing`-Auftrag mit abgelaufener Lease ist wieder zu haben, `mobile_upload.rs:1124/1143`,
  neues Token `:1153-1154`) und beim Vorbereiten jedes Fotos (`lease_until >= now`, `:743`). `mark_ready`, `release`,
  `quarantine` prüfen nur das Token (`:1310-1340`): ein Besitzer mit abgelaufener Lease darf fertig machen, solange niemand
  übernommen hat.
- **Reihenfolge der Übernahme:** Claim → Fotos vorbereiten (Rust, Lease-geprüft) → Produkt + Quittung + Changelog/Audit +
  Ingest-Aufträge in EINEM durablen Checkpoint → Medien veröffentlichen → Prüfen (`verifyReady` + Dreifachabgleich
  Quittung/Batch/Galerie) → `markReady` (Rust, eine Transaktion: Auftrag `ready`, Claim gelöscht).
- **Dauer einer Übernahme gegen die Lease:** gegen die Lease läuft nur das Vorbereiten: ≤ 8 Fotos (`MAX_UPLOAD_IMAGES`) ×
  Release-Obergrenze 4,3 s + 0,5 s (§ 4, Rauschen) ≈ 39 s < 120 s. Die Ganz-DB-Speicherungen danach (518 MB: je ~13 s) zählen
  für `ready` nicht gegen die Lease (nur Token). **Korrektur** der früheren Aussage (§ 8 im Stand `3035f49`: „mit 2 + N
  Ganz-DB-Speicherungen kann sie bei großer DB ablaufen (`ready_rejected`)"): Ablauf allein lehnt nichts ab; `ready_rejected`
  gibt es nur, wenn ein anderer Claimer übernommen hat.

| Gefahr | Schutz | Beleg |
|---|---|---|
| veralteter Besitzer | Übernahme vergibt ein neues Token; `mark_ready` mit altem Token → `Rejected` (B arbeitet noch) bzw. `AlreadyReady` (B fertig, gleiche Kennungen) — nie ein zweiter Übergang; `release`/`quarantine` mit altem Token wirken nicht; `ready_rejected` beendet die Runde | Rust `expired_claim_is_taken_over_and_old_token_is_stale`, `processing_claim_survives_reopen_and_reclaims_after_expiry`, `prepared_provenance_full_binding_deterministic_and_claim_gated` (abgelaufene Lease → kein Vorbereiten); TS `drain-handoff` §9, **§20 (neu)** |
| doppelte Übernahme | Produktkennung = `entity_id` des Auftrags, `products.id` PK; Quittung PK + `INSERT OR IGNORE` im selben Checkpoint (`productStore.ts:965`); ein zweiter Claimer findet die Quittung → Resume auf DASSELBE Produkt | Rust `claim_accepted_then_mark_ready_exactly_once`; `drain-handoff` §2 (Absturz nach Checkpoint → Resume), §9, §20 |
| Verlust | `ready` erst nach geprüftem, durablem Produkt; Speichern gescheitert → `release`; `pending` → `release` (Resume); Staging-Dateien bleiben bis `ready` (Aufräumen nur `conflict`/`quarantined`/verwaist, nach Karenz) | `drain-handoff` §2, §19 (Umbindung während des Laufs → freigegeben, weiter zu haben), §20 |

**Gezielter Test der einen Beweislücke:** bisher lief kein Test die Übernahme des alten Besitzers bis zu ihrem eigenen
abgelehnten `ready` (§9 legte A vollständig an, BEVOR B übernahm, und rief `markReady` direkt). Neu `drain-handoff` **§20**: A
übernimmt und legt durabel an; WÄHREND A prüft, läuft die Lease ab (+121 s) und B übernimmt mit neuem Token; A's Saga endet
`ready_rejected`, ohne B's Claim anzufassen (Auftrag bleibt `processing` bei B); B setzt fort (`resumed`) → `ready`; genau ein
Produkt, eine Quittung, ein Changelog, ein Audit, ein Batch (2 Aufträge), beide Fotos in der Galerie; ein spätes `ready` mit A's
altem Token → `already_ready`, ändert nichts. `node test/media04b2a2/drain-handoff.test.ts` **106/0** (vorher 94/0).
Wann ein zweiter Claimer überhaupt entsteht: im selben Fenster verhindert der Single-Flight das; nur ein neuer Worker (Epoche,
Filiale oder Bindungsrevision gewechselt) oder ein neu gestartetes Fenster (dann ist A tot) claimt.

Nicht bestätigt, nicht geändert (Verdacht, kein Umbau): (a) Vorbereiten > 120 s — nur im Debug-Build erreichbar — endet in
`CLAIM_INVALID` → Freigabe → derselbe Auftrag wird ohne Verlängerung erneut versucht; (b) zwei Worker zugleich UND A's
Checkpoint scheitert, nachdem B die noch nicht gespeicherte Quittung gesehen hat → B würde den Auftrag in Quarantäne setzen.
Beides braucht mehrere seltene Bedingungen zugleich; nicht nachgestellt.

## 6. Persistenz: regulärer Neustart und Stromausfall getrennt

**Speicherpfad und Vertrag (vorbestehend, unverändert):** `saveDatabaseDurably` (M2, `513bd1b` 14.07.2026: das Versprechen
erfüllt sich erst, wenn der Stand „dauerhaft auf die aktive DB-Datei geschrieben" ist, `database.ts:3351-3356`) →
Save-Coalescer → `db.export()` → `persistDb` → `atomicWrite` (`atomic-persist.ts:114-157`, eingeführt `88e1199` 08.07.2026):
Kopfprüfung → Stale-Guard (Größe + mtime) → `plugin:fs|write_file` in `lataif.db.tmp-<Sitzung>-<n>` (`tauri-plugin-fs 2.5.0`
`commands.rs:1090-1170`: öffnen + `write_all`, **kein `sync_all`**) → Größenprüfung → `plugin:fs|rename` (`commands.rs:830`
`std::fs::rename` = `MoveFileExW(REPLACE_EXISTING)`, **ohne `WRITE_THROUGH`**). „Dauerhaft" heißt in diesem Vertrag: in der
aktiven Datei im Dateisystem — nicht „auf den Datenträger geleert". Kein Dokument des Hauses sagt der Geschäftsdatenbank
Stromausfallfestigkeit zu (Suche Stromausfall/power loss/FlushFileBuffers: nur der Datenort-Umzug,
`data-root-i1-contract.md:430-431`, dessen Rust-Weg `sync_all` nutzt). Startschutz C6-P1 (`9a5505c` 07.09.2026): eine
vorhandene, nicht lesbare/öffenbare Datei → `DB_RECOVERY_REQUIRED`, nichts wird ersetzt.

**A. Regulärer Neustart, App-Absturz, erzwungenes Prozessende — fest.** Nach dem Umbenennen steht der neue Stand vollständig
im Dateisystem (Cache des Betriebssystems); jedes Ende des Prozesses lässt ihn stehen, der nächste Start liest genau diese Datei.
Ein abgebrochenes Schreiben lässt die alte Datei unberührt (Temp + Umbenennen). Belegt in jedem Neustart dieses Pakets
(`r7b-pp12-shutdown` 518 MB: Beenden → Neustart → Buchungen, Fotos Byte für Byte, Dokumente; Mobile- und Bildlauf ebenso).

**B. Stromausfall / Betriebssystemabsturz — Dauerhaftigkeit nach der Speicherbestätigung nicht garantiert.** Die Bestätigung
(`saveDatabaseDurably`) heißt „in der aktiven Datei im Dateisystem", nicht „auf dem Datenträger": auf dem Pfad leert nichts den
Cache (kein `sync_all`/`FlushFileBuffers`, Umbenennen ohne `WRITE_THROUGH`). Wann das Betriebssystem die Seiten selbst
zurückschreibt, steuert das Haus nicht und hat es nicht gemessen — **eine feste zeitliche Obergrenze des Risikofensters ist
nicht belegt.** Zurückgenommen: die Fassung in `19ac2da` („fest außerhalb eines Fensters von Sekunden", mit Verweis auf das
Rückschreiben des Betriebssystems) war eine unbelegte Garantie; die Fassung davor („übersteht keinen Stromausfall",
`3035f49`) war pauschal. Es gilt: regulärer Neustart belegt (A); Stromausfall-Dauerhaftigkeit nach Bestätigung nicht
garantiert; ohne zugesagte Frist.
- **Nach einem Stromausfall mögliche Zustände** (aus dem Speicherpfad abgeleitet, nicht nachgestellt):
  1. Umbenennen noch nicht im Journal → der vorige Stand; verloren sind die letzten Speicherungen, obwohl die Oberfläche sie
     bestätigt hatte.
  2. Umbenennen im Journal, Datenseiten noch nicht → nicht geschriebene Bereiche lesen sich als Nullen. Kopf genullt → sql.js
     `file is not a database` → `DB_RECOVERY_REQUIRED` (erkannt, Hinweis auf Wiederherstellen). Kopf da, spätere Seiten
     genullt → öffnet; erst der Zugriff meldet `database disk image is malformed` — beim Start **nicht** erkannt (keine
     `integrity_check`).
  3. **R4 (bestätigt, vorbestehend):** eine 0-Byte-Datei öffnet sql.js als LEERE Datenbank; `loadSavedDb` liefert `bytes`,
     `initDatabase` legt Schema und Migrationen an → die Anwendung startet leer statt mit `DB_RECOVERY_REQUIRED` — entgegen dem
     C6-P1-Satz „Ein neuer Bestand entsteht ausschließlich, wenn BEWIESEN ist, dass es keine Datei gibt" (`database.ts:2853-2856`).
     Im normalen Betrieb entsteht keine 0-Byte-Datei (Größenprüfung vor dem Umbenennen), nur durch einen Stromausfall/Absturz
     nach einem Speichern oder einen Eingriff von außen. Diagnose (sql.js 1:1 wie im Start): 0 B → geöffnet, Schema angelegt; 4096 Nullbytes → `file is not a
     database`; gültige Datei ab Seite 2 genullt → geöffnet, `SELECT` → `malformed` (Anhang `persistenz-diagnose.log`).
     Behebung wäre klein (Kopf-/Längenprüfung beim Laden → Recovery-Weg), ändert aber das Startverhalten → nicht in diesem
     Abschluss, offen.
- **Kein Vorgängerstand:** das Umbenennen ersetzt die Datei, `.bak`/Rotation gibt es nicht. Sicherungen entstehen auf Anstoß des
  Owners (`schedule_backup_snapshot`, `lib.rs:2699`, beim nächsten Start ausgeführt) und vor zerstörenden Aktionen; auch sie
  schreiben ohne `sync_all` (`media/backup.rs:195`; nur die Absichtsdatei `:311`).
- Rust-eigene Dateien (Medienspeicher `ingest.rs`/`storage.rs`, Handy-Staging `mobile_upload.rs`, Datenort, Geräte-Identität,
  Journale) rufen `sync_all`; der Verzeichnis-Sync ist best-effort. Nach einem Stromausfall können Mediendateien daher neuer sein
  als die Datenbank → verwaist → Aufräumen mit Quarantäne.

**Einordnung:** vorbestehend seit `88e1199` (08.07.2026), nicht Teil von PP-12, nicht geändert (kein allgemeiner
Speicherumbau). Ein `fsync` bräuchte einen eigenen Rust-Befehl (Temp + `sync_all` + Umbenennen + Verzeichnis-Sync) und kostet
bei 500 MB zusätzliche Sekunden je Speichern (gegen G5).

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

## 8. Skalierungsbefund normale Befehle (G5)

Jeder schreibende Befehl speichert die ganze Datenbank (`db.export()` + Schreiben): gemessen 0,1 s (2 MB), 5,3 s (203 MB),
10,6–12,7 s (451 MB). Die Frist normaler Befehle bleibt 20 s — bei ~450 MB ist die Hälfte davon Speichern; eine Wartezeit hinter
dem Selbst-Abgleich (bis 2 × 13 s bei 518 MB) reißt sie (504 `unknown`, Wirkung genau einmal, s. § 5). Das ist ein
Skalierungsbefund des Ganz-Datenbank-Speicherns, kein Fehler einzelner Wege; daraus werden hier weder eine pauschale
Fristerhöhung noch ein Speicherumbau abgeleitet (eigene Entscheidung). Die Handy-Drain-Lease (F2) steht jetzt in § 5a.

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

„vorher" = Stand `d988810` (gepushte Baseline); „nachher" = HEAD. Grenzen: Hauptbild/Belegbild JPEG ≤ 100 000 B, ≤ 1600 px;
Vorschau ≤ 20 000 B (nur Medienspeicher). Ausgenommen ist nur, was kein neues Foto speichert oder ein Original sein muss.

| # | Einstieg | Speicherort | vorher (`d988810`) | nachher (HEAD) | Ausnahme / Begründung | Beleg |
|---|---|---|---|---|---|---|
| A/B | Handy Collection anlegen / Galerie / Text | Medienspeicher | 100 000 / 20 000 B hart (`ingest.prepare`) | unverändert | — (war schon der zentrale Weg) | `drain-handoff` 106/0 |
| C/K | KI-Erkennen (Handy, Desktop, PC2) | nichts gespeichert | Transportgrenzen | unverändert | **Ausnahme**: speichert kein Foto; nur Transportgrenzen | R7B PP-3 |
| D | Handy Reparatur, Einkaufs-Inbox | `repairs.images`, `purchase_inbox.images` | **keine Byte-Grenze** (1600 px / 0,85 Canvas, ~475 000 B) | **≤ 100 000 B bei der Übernahme**, gespeicherte Byte für Byte, Umweg → Quarantäne | Vorschau nicht (Belegbild in der Zeile, G4) | `pp12-pulled-images` 26/0, `r7b-pp12-mobile-takeover` 20/0 |
| E | Desktop/PC2 Artikel, Kommission, Fertigung | Medienspeicher | hart, Aufnahme 800 px | unverändert | — | `r7b-pp12-images` 22/0 |
| F | Einkauf „New Item" (auch aus Inbox) | `products.images` → Medienspeicher | Spalte, keine Byte-Grenze (vor PP-12) | **Medienspeicher** (Hauptbild + Vorschau) nach dem Commit, Spalte `[]` | — | `pp12-new-item-media` 17/0, Mobile 20/0, Bilder 22/0 |
| G | Auftrag „New Item" / Sonderstück | Artikel; Entwurf `orders.custom_product_spec` | Spalte / Entwurf ohne Byte-Grenze | Artikel **Medienspeicher**; Entwurf Belegbild ≤ 100 000 B | Entwurf bleibt Belegbild (kein Artikel, kein Medienspeicher-Objekt) | Mobile 20/0, `pp12-images` 56/0 |
| H/I/J | Reparatur, Altgold, Ausweis (Desktop/PC2) | Zeile | ohne Byte-Grenze (vor PP-12) | ≤ 100 000 B am aufnehmenden Rechner, Primary prüft beim Abholen | Vorschau nicht (G4) | `r7b-pp12-images` 22/0 |
| X | jede Bildspalte über `/api/sync/push` | Zeile | **wörtlich** | **normalisiert bei der Übernahme**, gespeicherte Byte für Byte, unspeicherbar → Quarantäne | Transportvertrag des Servers bleibt wörtlich (Echo eigener Altzeilen) | `pp12-pulled-images` 26/0, Mobile 20/0 |
| L | Dokumente | `documents.file_path` (Original) | ≤ 25 116 672 B | unverändert, Frist nach DB-Größe | **Ausnahme**: Original = OCR-Vorlage und Beleg; nie umgerechnet | `r7b-pp12-large-db` 13/0 |
| M | Excel-Import | `products.images = []` | kein Foto | unverändert | **Ausnahme**: kein Foto | § 3 |
| N | Dubletten-Zusammenführung, Migration/Backfill, Speicherpflege | Bestand | kopiert/verschiebt vorhandene | unverändert | **Ausnahme**: kein neues Foto; Umrechnen wäre Konvertierung des Bestands | § 3 |

Die Matrix liegt dem Belegpaket zusätzlich als eigene Datei bei (`matrix/upload-wege-vorher-nachher.md`).

## 11. Tests und Nachweise (zum finalen Code)

Alle Läufe gegen den finalen Code (E2E-Programme nach dem letzten Codecommit neu gebaut: Primary + PC2-Client, Debug, isoliert
`com.lataif.app.e2e`, Port 3011; Produktion, `E:\LATAIF\Data`, 3001/3443 unberührt, jede fremde `lataif.exe` geprüft). Die
vollständigen Ausgaben stehen im Belegpaket (`tests/einheit-typcheck-rust-e2e_3035f49.log`, E2E-Protokolle in `shutdown/`,
`mobile/`, `bilder/`).

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

**Belegpaket (Nachtrag):** gezielt neu gelaufen, sonst wiederverwendet (Produktcode seit `fa4676a` unverändert; das Paket
ändert nur Doku, einen TS-Test und eine `#[ignore]`-Messfunktion):
- `test/media04b2a2/drain-handoff.test.ts` **106/0** (neu §20: Lease-Ablauf während der Übernahme, § 5a).
- Release-Messung Aufnahmeprofil `bench_capture_profile` + `bench_normalize_times` (3 Wiederholungen) und die normalen
  `media::record_image`-Tests im Release-Build; ein Debug-Lauf nur für den Byte-Vergleich (§ 4).
- Persistenz-Diagnose sql.js (§ 6, R4).
- Zuordnung jedes Laufs zu Quellstand und getesteter Binary (Build-Zeit, Hash, Produktcode-Gleichheit): `LIESMICH.md` im
  Belegpaket.

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
6. `3035f49` — E2E `r7b-pp12-shutdown`, `r7b-pp12-mobile-takeover`, Kommentar `r7b-pp12-large-db`, dieses Review, SSOT.
7. Folgecommit Belegpaket — Review §§ 0, 4, 5, 5a, 6, 10–12 (Callpaths Timeout/Wiederholung, Handy-Lease, Persistenz
   getrennt, Release-Begründung 800/1600 px, Matrix mit Ausnahmen, Restbefunde R1–R4); SSOT: frühere Sätze zur Wartezeit
   ausdrücklich korrigiert, Statuszeilen; `drain-handoff` §20; Messfunktion `bench_capture_profile` (`#[ignore]`). Kein
   Produktcode. (= `19ac2da`)
8. Folgecommit Review `19ac2da` — PP-5 Sitzungsablauf (`auth.ts`, `App.tsx`), PP-12 ungültige Bildformen
   (`pulled-record-images.ts`), ehrliche Meldung bei offenem Ausgang (`shared-write.ts`), Persistenz-Wortlaut (§ 6, SSOT),
   § 13; Tests `r7b-platform-hardening` 118/0, `pp12-pulled-images` 32/0.

## 13. Nachforderungen des unabhängigen Reviews zu `19ac2da` (R7B_REVIEW_CHANGES_REQUIRED)

**13.1 PP-5 — Ablauf der gespeicherten Sitzung.** Bestätigt: `verifyStoredSession` prüfte Token, Benutzer und Filiale, nicht
`sessions.expires_at` — eine abgelaufene Sitzung galt als `kept`. Im selben Callpath fing `App.tsx` einen Fehler der Prüfung nur
ab (`console.warn`) und lief weiter; der ungeprüfte Merkzettel blieb in `localStorage`, und `getSession()` hätte ihn übernommen.
Behebung (`auth.ts`): dieselbe Abfrage liest `se.expires_at` der eigenen Datenbank; kein lesbarer ISO-Zeitpunkt
(strikt das Format von `login`: `YYYY-MM-DDTHH:mm:ss(.sss)Z`, kalendarisch geprüft — Nachtrag unten) → `expiry-unreadable`, vorbei → `expired`, beides verworfen (Merkzettel weg, niemand angemeldet); jede Ausnahme
der Prüfung → `check-failed`, verworfen. `App.tsx`: der Fang ruft `discardStoredSession` (fail closed). `login` schreibt
`expires_at` als ISO-Zeit + 30 Tage — gültige Sitzungen bleiben. Nachweis `node test/r7b/r7b-platform-hardening.test.ts`
**118/0** (vorher 111/0): abgelaufen, unlesbar, leer → verworfen; Ablauf morgen (Format wie `login`) → `kept` mit der Rolle von
jetzt; fehlende `sessions`-Tabelle → verworfen; Verdrahtung des Fangs.

**13.2 PP-12 — ungültige Bildformen bis zur Schreibgrenze.** Callpath nach `prepareRecordImages`: `commitPulledBatch` →
`applySyncChange` (`apply-change.ts:420`) → `validateBusinessPayload` (`:281-326`: JSON-Objekt, doppelte Schlüssel, Größe,
Feldname in der Allowlist — laut Kommentar ausdrücklich keine Typ-/Wertregeln) → `applyUpsert` (`:340-380`: bindet jedes
Objekt als `JSON.stringify`). Der Server-Eingang `/api/sync/push` prüft ebenfalls nur Transport und Spalten-Allowlist (§ 2).
Ergebnis: **keine nachgelagerte Ablehnung** — die Form stünde wörtlich in der Zeile (im Test belegt: `applySyncChange` schreibt
`{"a":"x"}` in `repairs.images`). Behebung (`pulled-record-images.ts`): jede Bildspalte braucht eine gespeicherte Form — Liste:
Feld oder JSON-Text einer Liste aus Texten; Einzelfoto: Text; Auftragsentwurf: Objekt (oder JSON-Text) mit fehlender, leerer oder
gültiger `images`-Liste. Sonst `RECORD_IMAGE_SHAPE_INVALID` → dieselbe Quarantäne wie ein unspeicherbares Foto
(`SYNC_RECORD_IMAGE_REJECTED`, dieselbe Transaktion, der Stapel läuft weiter). Erlaubt bleiben leere Felder (`null`, `""`,
`[]`, `"[]"`, Entwurf ohne/mit leerer Fotoliste) und ein unverändert zurückgespielter Bestandswert (derselbe gebundene Wert wie
in der Zeile, auch in fremder Form — das Echo des Primary schickt keine Altzeile in die Quarantäne; eine GEÄNDERTE ungültige
Form schon). Nachweis `node test/r7b/pp12-pulled-images.test.ts` **32/0** (vorher 26/0; neu §7: Schreibgrenze, 12 ungültige
Formen über alle sechs Bildspalten, 11 gültige leere Formen, Bestandswerte).

**13.3 Persistenz-Wortlaut.** § 0, § 6 B und die SSOT-Zeile F1 ohne die unbelegte Frist-Garantie (s. § 6 B). Kein
Speicherumbau.

**13.4 Meldung bei offenem Ausgang.** `shared-write.ts` `fehlertext` sagte bei `BRIDGE_TIMEOUT` „it can never happen twice" und
sonst „it can never create it twice" — absolut, obwohl R1 nach Verlassen/Neuladen offen ist. Jetzt: „Press again on this form:
the same attempt is repeated and is not saved twice. If you leave this form or reload first, check whether it was saved before
entering it again." Keine Änderung an R1. Nachweis `r7b-platform-hardening` §6 (beide Meldungen, kein „never").

**Nicht erneut gelaufen** (unveränderter Callpath, gültige Nachweise): E2E-Läufe (gültige Bildformen gehen unverändert durch —
§7 „LEER"/„BESTAND" und §1–§4 grün; der Handy-Lauf sendet JSON-Text-Listen), übrige Einheitstests (`verifyStoredSession`,
`fehlertext`, `prepareRecordImages` haben keine weiteren Testaufrufer). `tsc -b` grün; Lint der geänderten Dateien ohne neue
Fehler. Offen, separat geführt und **nicht** stillschweigend akzeptiert: R1, R2, R3, R4, G5 (§ 0).

## 14. Technische Freigabe

Unabhängige Prüfung des Quellstands **`fca07b1e33929f972d7c66c8ca22789f8f7ab3bc`** abgeschlossen: Status
**`R7B_TECHNICAL_REVIEW_APPROVED_FCA07B1`**. Freigegeben sind die drei Nachforderungen zu `19ac2da` (PP-5 Sitzungsablauf und
Fehlerfall `App.tsx`, PP-12 ungültige Bildformen, Persistenz-Wortlaut) und die korrigierte Meldung bei offenem Ausgang (§ 13).
Die Freigabe gilt für diesen Commit; der nachfolgende Commit ändert nur Dokumentation (dieses Review, SSOT) — kein Produktcode,
keine Tests, keine neuen Läufe; es gelten die vorhandenen Nachweise.

Getrennt: technisch freigegeben **ja** · lokal committed **ja** · gepusht **nein** · released **nein** (0.8.54, Registry 175).
Nicht Teil der Freigabe und weiter offen, nicht akzeptiert: **R1, R2, R3, R4, G5** (§ 0).

**Nachtrag nach der Freigabe (PP-5-Randfall, eigener Folgecommit, nicht von `…APPROVED_FCA07B1` umfasst):** `fca07b1` las
`expires_at` mit Präfix-Regex + `Date.parse` — `2099-02-30` rollte still auf den 2. März und galt als gültig. Jetzt
`parseSessionExpiry` (`auth.ts`): nur das Format, das der einzige Schreiber `login` erzeugt (`toISOString`,
`YYYY-MM-DDTHH:mm:ss(.sss)Z`), mit Kalenderprüfung (Rückrechnung von Jahr/Monat/Tag) und Grenzen für Stunde/Minute/Sekunde;
nur Datum ist kein Bestand (kein Schreiber) und gilt als unlesbar. Nachweis `node test/r7b/r7b-platform-hardening.test.ts`
(gültig → `kept`; abgelaufen → verworfen; 30. Februar, 31. April, Monat 13/00, 24:00, Minute 60, Sekunde 61, nur Datum,
Zeitzone → `expiry-unreadable`, verworfen). Kein weiterer Lauf.

Version 0.8.54 und Registry 175 unverändert (keine technische Notwendigkeit).
