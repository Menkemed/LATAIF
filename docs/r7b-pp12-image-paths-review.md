# R7B / PP-12 — Bildwege, Vereinheitlichung, Frist nach der echten Speicherung

Stand 15.09.2026 · Basis `243e4e6` (R7B + Review) · Version 0.8.54 · Registry 175 (unverändert) · kein Push/Tag/Release.

Auftrag: alle produktiv erreichbaren Bild-Uploads (Handy, Primary, PC2) erfassen, fachlich gleichartige Bildwege auf
eine zentrale Verarbeitung führen, PP-12 anhand der echten Speicherwege schließen. Dokument-Uploads und Handy-Bilder
getrennt betrachtet; die großen Dokument-Messungen des Reviews sind kein Handy-Nachweis.

## 1. Bestandsaufnahme — Vorher / Nachher je Einstieg

Legende Speichern: **ganze DB** = jede Buchung exportiert die ganze sql.js-Datenbank und schreibt sie als Datei
(`saveDatabaseDurably` → `db.export()` → `atomicWrite`: Temp-Datei + Umbenennen; s. Befund F1 zu fsync).

| # | Einstieg (produktiv) | Auswahl → Transport → Handler | Speicherort | Grenzen & Durchsetzung VORHER | NACHHER |
|---|---|---|---|---|---|
| A | **Handy: Collection anlegen** (1–8 Fotos) | `mobile_page.rs` `resizePhoto(f, 1600, 0.85)` (Canvas, EIN Durchgang, kein Byte-Ziel) → IndexedDB-Warteschlange (`uploadEventId` einmal vergeben) → `POST /api/mobile/upload` (JSON, Base64) → `accept_upload` (Rust): Magic Bytes, ≤ 25 MiB, ≤ 8192 px, ≤ 24 MP, ≤ 8 Bilder, ≤ 40 MiB, Dekodierprobe; die **Originalbytes** gehen fsync'd in `mobile-upload-staging` → 201 „accepted" ans Handy. Desktop holt alle 15 s ab (Drain, Lease 120 s): `ingest.prepare` → `normalize_stock_image` + `create_thumbnail` → Datei im Medienspeicher → `createProductWithMedia` | Dateien `<Datenort>/media/…` (Haupt + Vorschau), Metadaten in 6 Media-Tabellen; `products.images = '[]'` | **Hauptbild ≤ 100 000 B, Vorschau ≤ 20 000 B — dezimal, HART** (`normalize.rs` Qualitätsleiter 85→40, dann −15 % Kante, unter 320/96 px Ablehnung `MEDIA_IMAGE_DETAIL_INSUFFICIENT`); am Handy und an der HTTP-Grenze nur Transportgrenzen. Speichern: ganze DB **2 + N-mal** je Auftrag (Registrierung, je Bild ein Checkpoint — `orchestrator.ts`) | unverändert (bereits der zentrale Weg). Transportfassung bleibt 1600 px / 0,85: sie ist die KI-Vorlage (MEDIA-02E), gespeichert wird nur die normalisierte Fassung |
| B | **Handy: Galerie ändern / Text ändern** | wie A, `kind: 'gallery_edit'`/`'text_edit'`; Galerie-Plan nennt `keep`/`remove` ausdrücklich, Baseline-Vergleich → `applyEditDurably` | wie A | wie A; Entfernen = Verknüpfung zurückziehen (Datei bleibt, GC); veraltete Baseline = endgültiger Konflikt | unverändert |
| C | **Handy: KI-Erkennen** | `collectionPhotos[0]` → `POST /api/ai/identify` → Rust → OpenAI (Schlüssel bleibt am Primary) | nichts gespeichert | Transport 25 MiB | unverändert |
| D | **Handy: Reparatur-Annahme, Einkaufs-Inbox-Foto** | `resizePhoto(1600, 0.85)` → Datensatz-JSON mit Daten-URL → `POST /api/sync/push` (Abgleich-Protokoll, Zeile wörtlich) | `repairs.images` / `purchase_inbox.images` (Base64 in der Zeile) | **keine Byte-Grenze**, nur 50-MiB-Rumpf | **unverändert — offen** (§ 5 G2) |
| E | **Desktop/PC2: Artikel anlegen/ändern, Kommission, Fertigung** | `ImageUpload` → Primary lokal: `createProductWithMedia`/`editProductWithMedia`; PC2: `POST /api/staging/media` (Rust prüft wie A, Kennung = SHA-256) → `products.create`/`products.update`/`consignments.create`/`production.create` → `readStagedAsDataUrls` (roh) → derselbe Medienweg | Medienspeicher (wie A) | 100 000 / 20 000 B HART (derselbe Normalisierer); Aufnahme 800 px / 0,7; eine unlesbare Datei riss die ganze Auswahl mit, Transparenz → Schwarz | Speicherweg unverändert. Aufnahmeprofil an EINER Stelle (`capture-profile.ts`), **bewusst 800 px / 0,7** (gemessen, § 3); unlesbare Datei wird übersprungen und genannt, Transparenz auf Weiß |
| F | **Einkauf „New Item"** (auch aus einem Inbox-Foto) | `NewProductModal`/`ImageUpload` → `createPurchaseOnPrimary` bzw. `purchases.create` (`mitFotos`) → `createPurchase` → `productStore.createProduct` | `products.images` (Base64 in der Zeile) | **keine Byte-Grenze**, 800 px / 0,7 als Ziel | **≤ 100 000 B, derselbe Normalisierer** — gerechnet am aufnehmenden Rechner (Primary: `normalizeSpecImages` vor der Klammer; PC2: `stageRecordDataUrls` vor dem Ablegen), geprüft beim Abholen (`invokeReadStagedRecord`) — Speicherort unverändert (§ 5 G3) |
| G | **Auftrag: neuer Artikel (Anlegen, Positionsdialog), Sonderstück-Entwurf** | `createOrderOnPrimary` / `orders.create`; `updateOrderLineOnPrimary` / `orders.update_line` | `products.images`, `orders.custom_product_spec` (Base64) | keine Byte-Grenze | **≤ 100 000 B, derselbe Normalisierer** (beide Wege) — Speicherort unverändert (§ 5 G3) |
| H | **Reparatur anlegen/ändern** | `ImageUpload` (≤ 6) → `createRepairOnPrimary`/`updateRepairOnPrimary` bzw. `repairs.create`/`repairs.update` (Fotos als `stagingId`/`keep:n`) | `repairs.images` | keine Byte-Grenze | **≤ 100 000 B, derselbe Normalisierer** (aufnehmender Rechner; Primary prüft beim Abholen); gespeicherte Fotos (`keep`) bleiben Byte für Byte |
| I | **Altgold anlegen/ändern** (3 + 3 je Zeile) | `ScrapTradeForm` → `create/updateScrapTradeOnPrimary` bzw. `scrap_trades.create/update` (PC2 legt beim Ändern ALLE Fotos neu ab) | `scrap_trade_lines.images_purchase/_sale` | keine Byte-Grenze | **≤ 100 000 B** (aufnehmender Rechner); PC2 legt die gespeicherten Fotos unverändert neu ab (`keep`), der Primary erkennt sie an ihrer Kennung (SHA-256) und behält die gespeicherte Fassung |
| J | **Lieferant: Ausweisfoto (CPR)** (SupplierList, SupplierDetail, PurchaseCreate) | `saveSupplierCreate/Update` bzw. `suppliers.create/update` (`cprImageStagingId`) | `suppliers.cpr_image` (+ Kopie im Beleg-Schnappschuss `purchases.supplier_snapshot`) | keine Byte-Grenze | **≤ 100 000 B** (Beschluss MEDIA-02F: auch Ausweis-/Belegfotos als Raster ≤ 100 KB) |
| K | **KI-Erkennen am Desktop / auf PC2** | Primary: Anbieter direkt; PC2: `/api/ai/identify` über den Primary (R7B PP-3) | nichts gespeichert | 25 MiB / 8192 px / 24 MP | unverändert (Vorlage = Aufnahmefassung) |
| L | **Dokumente** (Upload, Vorschau, Texterkennung) | `DocumentList` → `documents.upload` (Daten-URL im Rumpf) → `uploadDocumentInHouse` | `documents.file_path` (Original als Daten-URL) + Kopie in `sync_changelog` | Datei ≤ 25 116 672 B (Zeile ≤ 32 MiB); Texterkennung auf 12 MP begrenzt (nur im Speicher) | **Original bleibt** (§ 5 G1); Frist jetzt mit DB-Größe (§ 4) |
| M | kein Upload, nur der Vollständigkeit halber | Dubletten-Zusammenführung kopiert `images[0]` eines vorhandenen Artikels; Excel-Import schreibt `images: []`; Firmenlogo ist ein Text-URL-Feld | — | — | unverändert |

Fristen VORHER: Handy-`fetch` ohne Frist, axum ohne Zeitschicht; `/api/command` 20 s (Dokumente seit R7B größenabhängig); die
Drain-Lease 120 s. Fehler/Wiederholung: Handy — dieselbe `uploadEventId`, Ersatz nur über ausdrückliches `remove`; PC2 — dieselbe
`commandId` (504 = `unknown`, Wiederholung wartet in der Schreibreihenfolge und bekommt das eingefrorene Ergebnis).

## 2. Handy-Vorgabe 100 KB / 20 KB — tatsächliche Umsetzung

- Grenzen `MAIN_MAX_BYTES = 100_000`, `THUMB_MAX_BYTES = 20_000` (`src-tauri/src/media/normalize.rs`) — **dezimal** (nicht 102 400 /
  20 480), **hart**: die Kodierung probiert die Qualitätsleiter 85→40, verkleinert dann um 15 %, unter 320 px (Haupt) bzw. 96 px
  (Vorschau) wird abgelehnt statt still größer gespeichert. Die Vorschau wird unabhängig aus den Originalbytes gerechnet.
- Durchgesetzt beim Übernehmen am Desktop (`ingest.prepare`), zusätzlich beim Lesen gespeicherter Dateien (`MAX_STORED_BYTES`). Am
  Handy und an `/api/mobile/upload` gelten nur die Transportgrenzen; gesendet werden typ. 200–600 KB je Foto.
- Nicht erhöht, nicht verändert. Beweis: `cargo test` Byte-Budget-Tests (`main_image_within_100kb_and_decodable`,
  `thumbnail_within_20kb_and_decodable`) und — für den Medienspeicher-Weg am PC2-Transport — der Lauf unten (Punkt „Medienspeicher").
- Die Handy-Wege sind in diesem Auftrag unverändert; ein Handy-E2E wurde deshalb nicht wiederholt (gültige Nachweise: v0.8.47/48-Gates).

## 3. Gewählter gemeinsamer Bildweg und Begründung

**Grundlage: der Rust-Normalisierer des Medienspeichers (`normalize_stock_image`).** Er ist der einzige vorhandene Weg mit harter
Byte-Grenze, Magic-Byte-Prüfung, EXIF-Ausrichtung und Metadaten-Entfernung; Handy (A/B) und Desktop-Artikelbilder (E) nutzen ihn
bereits, er ist mit Einheitstests und live (v0.8.47) belegt. Verworfen: die Browser-Kompression (`ImageUpload`, ein Ziel ohne
Grenze, keine Fehlerbehandlung, Transparenz → Schwarz) und eine zweite Byte-Schleife in JavaScript (zweite Implementierung derselben
Regel, am Primary nicht erzwingbar).

Umsetzung: `media::record_image::normalize_record_image` = derselbe Normalisierer mit den Eingangsgrenzen des Hauses
(25 MiB / 8192 px / 24 MP wie `/api/mobile/upload` und die Ablage). Ein Foto, das schon die gespeicherte Form hat (JPEG,
≤ 100 000 B, ≤ 1600 px, kein Metadaten-Segment APP1…APP15, dekodiert vollständig), bleibt Byte für Byte — die Funktion ist
idempotent. Zwei Tauri-Befehle, beide neben dem Hauptfaden (`spawn_blocking`): `media_normalize_record_image` und
`staging_media_read_record` (Abholen aus der Ablage).

**Wo gerechnet wird — befundbasiert.** Der erste Lauf ließ den Primary die Belegbilder beim Abholen rechnen: zwei große Fotos
rissen die 20-s-Frist eines normalen Befehls (504, E2E-Programm im Debug-Build). Messung im Release-Build (`record_image`-Bench,
`cargo test --release … bench -- --ignored`):

| Vorlage | Eingang | Hauptbild | Zeit Hauptbild | Zeit Vorschau |
|---|---|---|---|---|
| Foto 3000×2000, q92 | 2 588 031 B | 96 155 B 1600×1067 | 969 ms | 292 ms |
| Aufnahme 1600×1067, q85 | 559 629 B | 96 902 B 1156×771 | 1 609 ms | 80 ms |
| Aufnahme 800×533, q70 | 98 496 B | 98 493 B 800×533 | 72 ms | 24 ms |
| Rauschen 3000×2000 (Obergrenze) | 12 145 821 B | 98 636 B 834×556 | 4 279 ms | 480 ms |

Daraus: (1) Belegbilder rechnet der **aufnehmende Rechner** — am Primary VOR der Klammer (das Umrechnen hält die
Schreibreihenfolge nicht auf), auf PC2 VOR dem Ablegen (`stageRecordDataUrls`, derselbe Rust-Befehl derselben Anwendung). Der
Primary prüft beim Abholen trotzdem; ein Foto in gespeicherter Form übernimmt er Byte für Byte, alles andere (z. B. ein älterer
Client) rechnet er selbst. (2) Das Aufnahmeprofil des Desktops bleibt **800 px / 0,7**: ein Artikel mit 8 Fotos wird vom
Medienspeicher am Primary INNERHALB der 20-s-Frist normalisiert (Haupt + Vorschau) — mit 1600-px-Aufnahmen ~13,5 s nur für die
Bilder, mit 800 px ~0,8 s. Transporte bleiben verschieden, wo nötig (Handy: Inbox + Drain; PC2: Ablage + Befehl; Primary: direkt).

## 4. Änderungen

1. **Rust** `src-tauri/src/media/record_image.rs` (neu, 4 Tests); `lib.rs` zwei Befehle + Registrierung; `media/mod.rs`.
2. **TS** `src/core/media/record-image.ts` (neu): `normalizeRecordImages(urls, { keep })`, `normalizeRecordImage`,
   `normalizeSpecImages`, feste Codes + Meldung (`MEDIA_IMAGE_DETAIL_INSUFFICIENT` → „take a closer photo"); `sha256OfDataUrl`.
   `src/core/bridge/remote-create-support.ts`: `invokeReadStagedRecord`, `readStagedAsRecordImages`.
3. **Belegbild-Eingänge** — Primary (vor der Klammer): `repair-house.ts` (anlegen/ändern, `keep` = gespeicherte Fotos),
   `metal-actions.ts` + `scrap-house.ts` (`withRecordScrapPhotos`, `storedScrapPhotos`), `masterdata-save.ts` (Ausweis,
   `keep: base.cprImage`), `purchase-house.ts`, `order-house.ts`, `order-lifecycle-house.ts` (`normalizeSpecImages`).
   PC2 (vor dem Ablegen): `client-staging-upload.ts` `stageRecordDataUrls` in RepairList, RepairDetail, PurchaseCreate,
   OrderCreate, OrderDetail, `masterdata-save.ts`, `metal-actions.ts` (`stageScrapPhotos`, gespeicherte Fotos als `keep` aus
   ScrapTradeDetail). Primary beim Abholen: Standardleser `invokeReadStagedRecord` in `service-commands.ts` (2),
   `metal-commands.ts` (+ Behalten per SHA-256), `masterdata-commands.ts`, `commercial-commands.ts` (`runPurchaseCreate`,
   `runOrderCreate`, `mitFotos`), `order-lifecycle-commands.ts`. Artikel, Kommission, Fertigung bleiben roh (`stageDataUrls` /
   `invokeReadStaged`) — der Medienspeicher normalisiert selbst, mit Vorschau.
4. **Aufnahme** `src/core/media/capture-profile.ts` (neu) + `ImageUpload.tsx`: das Profil an einer Stelle (800 px / 0,7, § 3),
   Transparenz auf Weiß, eine unlesbare Datei wird übersprungen und genannt (`data-image-upload-skipped`), die gültigen bleiben.
5. **PP-12** `bridge.rs` `timeout_for(op, payload, db_bytes)`, `routes.rs` liest die Größe von `lataif.db` am Primary
   (`frontend_db_path`). Formel und Messgrundlage § 6.
6. **Tests** `test/r7b/pp12-images.test.ts` (neu), `test/e2e/r7b-pp12-images.e2e.mjs` (neu), Rust-Tests; angepasst: IPC-Grenze
   `test/bridge/_tauri-shim.ts` (beide Befehle), `r6d/metal-scrap-parity` (Normalisierer gestellt, Erwartung JPEG),
   `r6f/order-parity` (Ablage-Leser liefert JPEG), `r7b-platform-hardening` (Signatur).

Bestehende Medien: nichts wird umgerechnet oder gelöscht. `keep` (Primary) bzw. der SHA-256-Abgleich (PC2-Altgold) lassen jedes
gespeicherte Foto Byte für Byte stehen — auch ein Altbild über 100 KB.

## 5. Verbleibende Unterschiede und Grenzen (offen, begründet)

- **G1 Dokumente:** Originale bleiben unverändert (auch Bilder). Grund: Beleg-/OCR-Vorlage; die Auftragsvorgabe verbietet eine
  ungeprüfte Reduktion; die OCR-Begrenzung (12 MP) arbeitet nur im Speicher.
- **G2 Handy Reparatur-Annahme / Einkaufs-Inbox:** laufen über den Abgleich-Push (Zeile wörtlich) — ohne Byte-Grenze. Eine
  Normalisierung bräuchte entweder eine Umschreibung im Abgleich-Server (dessen Vertrag: gespeichert wird, was gesendet wurde) oder
  eine zweite Byte-Schleife im Handy — beides eigener Umfang. Das Inbox-Foto wird beim Einkauf „New Item" normalisiert (F).
- **G3 Speicherort Einkauf/Auftrag „neuer Artikel":** gleiche Verarbeitung/Grenze, aber weiter `products.images` statt Medienspeicher.
  Grund: `createPurchase`/`createOrder`/`updateOrderLine` sind synchrone Teile der Buchungsklammer; der Medienspeicher-Weg ist
  asynchron (Checkpoints, Datei-Veröffentlichung vor dem Commit) — der Umbau berührt den Einkaufs-/Auftrags-Buchungsweg und seine
  Tests (eigener Schnitt, Muster: Fertigung). Vorhandene Altbilder lesen weiter über den Rückfall des Resolvers.
- **G4 Keine Vorschau (20 KB) für Belegbilder:** die Zeile trägt je Eintrag ein Bild; eine Vorschau gehört zum Medienspeicher.
- **G5 Normale Befehle bleiben 20 s** (Umfang). Auch ein normaler Befehl speichert die ganze Datenbank: gemessen 0,1 s (2 MB),
  5,3 s (203 MB), 10,7 s (451 MB); mit belegter Schlange lag er bei 453 MB über 20 s (504 `unknown`). Ab einigen hundert MB wird
  die 20-s-Frist normaler Befehle eng — eigene Entscheidung (Frist oder Speicherweg).
- **F4 Beenden bei großer Datenbank (Befund, nicht geändert):** nach WM_CLOSE endete der Primary bei ~340 MB nicht in 15 min und
  bei 518 MB nicht in 10 min. Die Close-Orchestrierung schließt nur nach bestätigtem Flush und bleibt sonst offen (Regel A/B,
  `close-orchestration.ts`) — kein Datenverlust, aber kein Ende. Ursache nicht isoliert (Flush zu langsam, gescheitert oder
  eine wartende Operation); bei ~70 MB beendete er in denselben Läufen regulär.
- **G6 Warteschlange:** die Frist beginnt mit der Übergabe an das Fenster; ein Auftrag hinter einem anderen langen (z. B. OCR) wartet
  in ihr mit. Bei Ablauf: 504 `unknown`; die Buchung läuft im Fenster weiter und kann schon gespeichert sein; dieselbe `commandId`
  wartet in der Schreibreihenfolge und bekommt das eingefrorene Ergebnis. Eine Ergebnisabfrage ohne erneutes Senden gibt es nicht.
- **F1 fsync (Befund, nicht geändert):** `saveDatabaseDurably` schreibt über `@tauri-apps/plugin-fs` `writeFile` + `rename`;
  `tauri-plugin-fs 2.5.0` `write_file_inner` ruft nur `write_all`, kein `sync_all` — „durabel" heißt hier atomar (Temp + Umbenennen),
  nicht auf die Platte gezwungen. Rusts eigenes `data_root::write_atomic` ruft `sync_all`.
- **F2 Handy-Drain (Beobachtung):** Lease 120 s, `renew` wird nie gerufen; mit 2 + N Voll-Speicherungen je Auftrag kann ein großer
  Auftrag bei großer Datenbank die Lease verlieren (`ready_rejected`); der nächste Lauf nimmt ihn über die Quittung wieder auf.
- **F3 PC2 Artikel mit 8 Fotos:** Normalisieren (Haupt + Vorschau je Foto, bei 800-px-Aufnahmen ~0,1 s je Foto im Release) und das
  ganze Speichern laufen in den 20 s eines normalen Befehls — bei großer Datenbank kann die Frist reißen (dann `unknown` +
  Wiederholung wie oben). Unverändert (Umfang: normale Befehle 20 s).
- **G7 Aufnahmeprofil Desktop ≠ Handy:** Desktop 800 px / 0,7, Handy 1600 px / 0,85 — gemessen begründet (§ 3). Gespeichert wird
  auf beiden Wegen ≤ 100 000 B; Desktop-Artikelbilder bleiben dadurch höchstens 800 px breit.

## 6. PP-12 — Frist nach der echten Speicherung

Callpath (unverändert, geprüft): `command_execute` → `timeout_for` → `submit_as` → `dispatch`: die Frist beginnt NACH dem Lesen des
HTTP-Rumpfs mit der Übergabe ans Fenster (`tokio::time::timeout` auf die Antwort). Im Fenster: `runExclusive` → Transaktion →
`uploadDocumentInHouse` (+ Abgleich-Zeile) → Commit → `saveDatabaseDurably` (ganze DB) → erst dann `bridge_reply`.

```
upload   = 20 s + min(len, 32 MiB) × 10 / 10 MB/s  +  (db_bytes + 2 × len) / 4 MB/s
set_ocr  = 20 s + 10 s + 12 MP / 0,2 MP/s          +  db_bytes / 4 MB/s
content  = 20 s + 32 MiB × 4 / 10 MB/s             (liest nur, speichert nichts)
sonst    = 20 s
```

`db_bytes` = Größe von `lataif.db` am Primary im Moment der Anfrage. Untergrenze 4 MB/s gegen gemessen ~10 MB/s (+134 MB → +13,4 s).
Die Review-Messungen gegen die neue Frist: 17,9 / 23,0 / 31,3 s bei 69 / 136 / 203 MB → Frist 87,5 / 104,2 / 121,0 s, Abstand
4,9× / 4,5× / 3,9× (vorher 3,0× / 2,3× / 1,7×).

**Größere synthetische Datenbank** (`test/e2e/r7b-pp12-large-db.e2e.mjs`, nur der Test-Datenordner, zufällige nicht komprimierbare
Füllzeilen; je Stufe über `/api/command` mit leerer Schreibreihenfolge; „fertig" = die Zeile steht in der Datei, gemessen am
Aufrufer ab Beginn der Anfrage, eine Probe je Punkt):

| DB bei der Anfrage | normaler Befehl (Frist 20 s) | größtes Dokument: fertig / Frist | alte Frist | Texterkennung: fertig / Frist |
|---|---|---|---|---|
| 2 MB | 0,1 s | 17,8 s / 70,6 s | 53,5 s | 2,9 s / 107,2 s (DB 69 MB) |
| 203 MB (Lauf 1) | 5,3 s | 21,9 s / 121,0 s | 53,5 s | 7,5 s / 157,5 s (DB 270 MB) |
| 451 MB (Lauf 2) | 10,7 s | 27,8 s / 182,9 s | 53,5 s | 13,4 s / 219,5 s (DB 518 MB) |

Alle Antworten 200, jede Wirkung genau einmal. Getesteter Bereich: bis 451 MB (Upload) bzw. 518 MB (Texterkennung). Die Messung
trägt nicht, dass die alte Frist bei 451 MB gerissen wäre (27,8 s < 53,5 s bei leerer Schlange). Sie trägt aber: im ersten Lauf
(453 MB, direkt nach dem Start, Schlange belegt) lag schon der normale Befehl über 20 s, und das größte Dokument brauchte 192,8 s —
über der neuen Frist (183,4 s), weil die Frist die Wartezeit hinter anderen Aufträgen nicht enthält (G6). Die Untergrenze
(4 MB/s) bleibt: die gemessene Speicherleistung lag bei 451 MB über ~40 MB/s (normaler Befehl 10,7 s); die Formel lässt dem
größten Dokument dort 6,6× Luft.

## 7. Tests und Nachweise

**Einheitstests (Node):** `test/r7b/pp12-images.test.ts` **56/0** (Aufnahmeprofil, Normalisierer-Vertrag mit `keep`, Codes, jede
Verdrahtung Primary/PC2/Abholen, Medienspeicher-Wege roh, Frist-Formel gegen die Review-Messungen). Nachbarn nach der Änderung
grün: r7b-platform-hardening 111/0, r6c masterdata-parity 89/0, r6f order-parity 253/0, r6d metal-scrap-parity, r5c repair-parity,
r5e order-purchase-parity, r5e order-contract-pins 70/0, r6f purchase-parity 203/0, r6f product-media-parity, r6f production-parity,
r6f/r6c/r6d final-gate, uiparity r4b/r4c, bridge client-masterdata-ui, service-parity 112/0, commercial-documents 238/0,
pp13 repair-cost-accounting, media-edit-preserve edit-routing 34/0, r5f returns-consignment-parity. Typcheck grün; Lint: keine neuen
Fehler (Fehlerzahl je geänderter Seite gegen HEAD gleich).

**Rust:** `media::record_image` **6/0** (+ 1 Bench, ignoriert) — ≤ 100 000 B aus 3000×2000, Antwortform, gespeicherte Form bleibt
Byte für Byte (idempotent), Metadaten-/Maß-/PNG-Eingänge werden gerechnet, feste Codes, Eingangsgrenzen; `bridge_tests` inkl.
`the_writing_document_paths_grow_with_the_database` (46/0 mit `record_image` im ersten Lauf).

**Zwei-Rechner-Lauf Bildwege** `test/e2e/r7b-pp12-images.e2e.mjs` (frische E2E-Programme, Debug-Build) — Bildteil **22/0**:
- PC2 normalisiert vor dem Ablegen: Aufnahmen 84 785–94 478 B → 55 458–99 526 B; der Primary übernahm sie Byte für Byte
  (SHA-256 gleich), Reparatur mit zwei Fotos 617 ms.
- Nicht normalisiertes Foto (399 644 B, 1000×667, Qualität 0,95) → der Primary rechnete beim Abholen: 91 026 B, 3,2 s (Debug).
- Wiederholung derselben Kennung: dieselbe Reparatur, genau eine, Fotos unverändert. Ersetzen: erstes Byte für Byte, neues ≤ 100 000 B.
- Primary-Maske: Kamerafoto 2 653 984 B (3000×2000) über die echte Dateiauswahl → gespeichert 97 454 B (800×533); die zwei
  gespeicherten unverändert.
- Ausweisfoto, Einkauf „New Item": gespeichert = die von PC2 normalisierte Fassung. Altgold ändern: das neu abgelegte, schon
  gespeicherte Foto blieb Byte für Byte, das neue ≤ 100 000 B.
- Medienspeicher (Artikel vom PC2-Transport): Hauptbild 99 526 B, Vorschau 16 337 B als Dateien (Dateigröße = Datensatz),
  `products.images = '[]'`, 5,0 s (Debug). Die Maße führt `media_blob_generations` hier nicht (NULL) — geprüft sind Bytes und Datei.
- Anzeige: Primary und PC2 (echte Oberfläche, angemeldet als B) zeigen Reparaturfotos, Einkaufsartikel und Medienspeicher-Artikel.
- Reguläres Beenden + Neustart: alle Fotos Byte für Byte da, Medien-Dateien unverändert, Anzeige wieder da.
- Befund dieses Laufs, der das Design bestimmt hat: im ersten Anlauf rechnete der Primary zwei rohe Fotos (3000×2000) beim Abholen —
  504 nach 20 s (§ 3).

**Große Datenbank** `test/e2e/r7b-pp12-large-db.e2e.mjs` **13/0** (Lauf 2; Zahlen § 6) —
`POST_PARITY_PP12_LARGE_DATABASE_DEADLINE_PROVED`. Lauf 1 brach beim Übergang 270 → 450 MB ab: nach regulärem Schließen endete
der Primary (DB ~340 MB) nicht in 15 min (Befund F4); seine 2- und 203-MB-Stufe sind vollständig gemessen (Log). Deshalb misst
Lauf 2 nur Ausgangsgröße und 451 MB; am Ende endete der Primary nach WM_CLOSE auch dort nicht (602 s, DB 518 MB) und wurde
über den Prozess-Helfer beendet — nur dieser eigene Test-Prozess am exakten Test-Pfad. Produktion, `E:\LATAIF\Data`,
Ports 3001/3443: unberührt (Isolationsprüfung in jedem Lauf).

Rust-Nachbarn: `sync::routes`, `staging_route_tests`, `mobile_ingress_route_tests`, `w4`, `bridge`, `media::record_image` —
127/1; der eine rote Test (`legacy_push_tests::o1_o5_o10_operation_matrix_enforced_for_every_table`, erwartet 50 Insert-Tabellen,
das Abgleich-Manifest hat 52) ist **vorbestehend** seit R7A (`aaa14d9` erweiterte `sync-business-schema.json`; Datei und Test in
diesem Auftrag unverändert) — nicht behoben, gemeldet.

## 8. Git

Folgecommits auf `243e4e6` (kein Amend, kein Push/Tag/Release):

1. `02c976b` — Rust: `media::record_image` + zwei Tauri-Befehle (Normalisierer für Belegbilder).
2. `1479b09` — Rust: PP-12-Frist mit Datenbankgröße (`bridge.rs`, `routes.rs`, Tests).
3. `e1706a7` — TS: Bildwege vereinheitlicht (Primary vor der Klammer, PC2 vor dem Ablegen, Prüfung beim Abholen), Aufnahmeprofil,
   Einheitstests, angepasste Nachbartests.
4. dieser Commit — E2E-Läufe (`r7b-pp12-images`, `r7b-pp12-large-db`), dieses Review, SSOT (PP-12 geschlossen).

Version 0.8.54 und Registry 175 unverändert (keine technische Notwendigkeit).
