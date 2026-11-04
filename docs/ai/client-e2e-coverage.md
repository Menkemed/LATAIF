# Alte Client-E2E (C3B–C3G, C5) → heutige Abdeckung

Stand v0.8.97. Die sieben Läufe klickten die Navigation `data-client-area` des alten Client-Bereichs (`src/components/client/*`), den `71d1fc4` entfernt hat (0 Treffer in `src`). Seitdem nutzt PC2 dieselben Seiten wie der Primary. Die Läufe brachen im Aufbau ab und prüften nichts mehr.

Jede ihrer Prüfungen ist unten einer laufenden Prüfung zugeordnet. Wo keine gleichwertige existierte, ist sie neu entstanden:
- `test/e2e/pc2-reliability.e2e.mjs` (zwei Apps, heutige Oberfläche, Abschnitte A1–A5, B1–B7, I);
- `test/bridge/financial-actions.test.ts` §7/§7b;
- `test/pc2-reachability/primary-reachability.test.ts`;
- `test/bridge/c4-authorization.test.ts`.

Erst danach sind die sieben Dateien entfernt worden.

Rennen und alte Stände prüften die alten Läufe schon damals per rohem HTTP, nicht über die Oberfläche. Die Ersatzprüfung ist dort ebenfalls echtes HTTP gegen den laufenden Primary (A5) bzw. der Befehlsweg.

## C3B `client-invoice-ui` — Rechnung anlegen

| Risiko | heute |
|---|---|
| getrennte Builds, kein Testschalter, Single-Instance | Preflight `assertE2eClientBinary` in jedem Zwei-App-Lauf; `c4-authorization` „kein Testschalter" und **neu** „Single-Instance-Sperre eingebaut" |
| PC2 ohne Datenbank | r3 406/408, r4b 565, r6b „alte lataif.db unberührt", r6e; **neu** A1/I |
| Rechnung anlegen: Nummer vom Primary, Bestand, Buchung | r4b 444–459/557, r6e INV-CREATE (Kreis, Parität, Hauptbuch), r6e Zahltag/Buchungstag |
| Antwort verloren → dieselbe Kennung, eine Wirkung | r4b 533–557, r6e LOST `invoices.create` |
| 504 BRIDGE_TIMEOUT als Meldetext | Node `client-invoice-ui.test.ts`, `r7b-platform-hardening.test.ts`; die Oberfläche läuft über denselben „unknown"-Zweig wie der Netzabbruch (r4b, r6e) |
| fachliches Nein (Stück weg) → klarer Grund, neuer Versuch = neue Kennung | **neu** B4 (über die PC2-Oberfläche) |

## C3C `client-masterdata-ui` — Kunde, Artikel mit Foto

| Risiko | heute |
|---|---|
| Kunde anlegen / ändern | r4b 7A/7B, r7c S1 |
| Antwort verloren bei `customers.update` | **neu** B5 |
| Artikel mit Foto, Ablage, ein Medienlink, SKU vom Primary | r5b 406–457 (auch verlorene Antwort), Rust `media_staging_tests`, Node `product-remote-write` |
| Galerie behalten + hinzufügen | r6f 1450–1487 |
| Galerie-Speichern mit verlorener Antwort | Node `product-gallery-edit.test.ts` 257–272, `r6f/product-media-parity`; über die Oberfläche nur Artikel-Anlage mit Foto (r5b) — **Restrisiko, siehe unten** |
| „kein SKU-Feld am Client" | veraltet: die gemeinsame Maske erlaubt eine SKU, der Primary prüft sie (`product-remote-write` 569–579) |

## C3D `client-invoice-lifecycle` — Rechnung ändern und bezahlen

| Risiko | heute |
|---|---|
| Ändern (Zeile, Betrag) mit Grund, Bestand/Buchung | r6b EDIT (Notiz/Datum), **neu** B2 (Zeilenbetrag, Forderung genau einmal neu) |
| Antwort verloren bei `invoices.update` | **neu** B2 |
| alter Stand → INVOICE_CHANGED an PC2 | **neu** B3; Node `invoice-revision.test.ts` RACE-A |
| Zahlung | r4c 367–390, r6b PAY, r6e PAY-FINAL |
| Antwort verloren bei `invoices.record_payment` | r6e PAY-FINAL-NORMAL **jetzt mit verlorener Antwort** (LOST_OPS) |
| zwei Zahlungen gleichzeitig | **neu** A5c (echtes HTTP), Node `invoice-lifecycle` 476–509 |

## C3E `client-commercial` — Einkauf, Kommission, Auftrag

| Risiko | heute |
|---|---|
| Einkauf anlegen, verlorene Antwort | r5e 694–736, Node `commercial-documents` 236–285 |
| Kommission anlegen / ändern | r5b 505–618, r4c3 §4 |
| alte Fassung der Kommission an PC2 | **neu** B6 (RECORD_CHANGED, nichts überschrieben) |
| Auftrag anlegen / ändern | r5e 561–672 |
| alte Fassung beim Auftrag | Node `commercial-documents` 729–731, 818–829; gleicher Mechanismus über die Oberfläche: B6, r6e STALE, purchase-edit-pc2 |
| Nummern bei gleichzeitigen Anlagen | Node `commercial-documents` 769–799; echtes HTTP mit gleichzeitigen Anlagen: **neu** A5a/A5b |
| gesperrte Operationen | Node `commercial-documents` 184–188; `consignments.record_sale` ist inzwischen freigegeben (veraltete Erwartung) |

## C3G `client-financial` + `client-transfer-lifecycle` — Geld

| Risiko | heute |
|---|---|
| Guthaben verrechnen, verlorene Antwort | **neu** B1 (Guthaben aus echter Überzahlung, zweiter Klick dieselbe Kennung, genau einmal verbraucht); Node `financial-actions` 262–282 |
| Zahlung berichtigen: verlorene Antwort / alter Stand | Node `financial-actions` 322–332, 379–394 — **Restrisiko, siehe unten** |
| Auftrag → Rechnung, zwei Rechner | Node `financial-actions` 452–461, r5a |
| Auszahlung, Wiederholung | r5f 640–649 |
| Verkauf unter Preis: Absage ohne Spur | **neu** `financial-actions` §7 (kein Preis, keine Buchung, dieselbe Fassung); über die Liste **neu** B7 (Produktkorrektur, siehe unten) |
| zwei Rechner verkaufen denselben Transfer | **neu** `financial-actions` §7b RACE-SOLD |
| Abrechnen, Wiederholung, Endzustand | **neu** `financial-actions` §7 (eine Abrechnungszahlung samt Geldbuchung, „paid", Fassung +; Replay ohne zweite) |
| zwei Rechner rechnen gleichzeitig ab | **neu** `financial-actions` §7b RACE-SETTLE |
| PC2 ohne Datenbank | r5d1 529, **neu** I |

## C5 `c5-operational-acceptance` — Betrieb

| Risiko | heute |
|---|---|
| Lesen vom Primary, Parität | r3, r7c PARITAET |
| Primary aus: Lesen sagt es | **neu** A1 + Produktkorrektur Erreichbarkeitsleiste (unten); Node `primary-reachability` |
| Schreiben ohne Primary: nichts lokal, offener Vorgang | **neu** A1; `pc2-save-reliability` NIE |
| Primary-Neustart, PC2 arbeitet weiter, Klären | r7c S3/S4 (regulär); **neu** A2 (nach HARTEM Aus, „not saved" → „Save it now") |
| Antwort verloren nach der Buchung | r7c S1, r6e LOST (6 Befehle), r6d, pc2-save-reliability |
| getrennt vor dem Versand | pc2-save-reliability NIE |
| Renderer-Neuladen mit offenem Auftrag | Rust `bridge_tests` 144/181/815, Node `write-foundation` 202–234 |
| harter Kill: Wirkung + Nachweis auf der Platte, Replay nach Neustart | **neu** A3 |
| PC2 hart beendet mitten im Speichern | **neu** A4 |
| gleiche Kennung gleichzeitig | **neu** A5a |
| das letzte Stück gleichzeitig | **neu** A5b |
| Telefone laden hoch, während beide schreiben | Node `command-scheduler` 189–227; `c5-media-restart-durability` (harter Kill, Medien) |
| Medien überleben den Neustart | `c5-media-restart-durability` |
| Datenbank am Ende heil | **neu** I (integrity_check, Hauptbuch je Buchung ausgeglichen, keine doppelte Zahlungsbuchung) |
| Anmeldung im Betrieb (abgelehnter Ausweis) | Rust `command_route_auth_matrix`, r7b-platform-hardening BADTOKEN; Anzeige „signed_out" **neu** in `primary-reachability` |

## Produktkorrekturen, die die Analyse ausgelöst hat

1. **PC2 sagt nicht, dass der Primary weg ist.**
   - Befund: `remote-read.ts` verspricht „Ist der Server weg, sagt der Client das", aber `setRemoteLoadFailureHandler` hatte keinen Aufrufer. Lesefehler landeten nur in der Konsole, und die Seiten zeigten still den alten Stand oder leere Listen.
   - Korrektur: `remoteRead` meldet die Erreichbarkeit (`unreachable` / `signed_out` / `ok`). Auf PC2 zeigt `PrimaryReachabilityBar` sie an, mit „Reload" bzw. „Sign in".
   - Unverändert: Am Primary ändert sich nichts. Lese- und Schreibergebnisse bleiben, wie sie waren.
2. **Transferliste: Verkauf unter Our Price nicht möglich.**
   - Befund: Der „Sold"-Dialog der Liste bot die Bestätigung der Detailseite nicht an. Ein Split-Transfer unter Our Price wurde deshalb auf beiden Rechnern immer abgewiesen, mit einer Meldung, die den internen Parameter nannte. Der Dialog schloss sich auch bei Ablehnung.
   - Korrektur: dieselbe Warnung mit Checkbox wie auf der Detailseite (`data-transfer-sold-ack`). Der Dialog schließt nur bei Erfolg und zeigt den Fehler selbst an.

## Produktkorrekturen aus der Analyse von mobile-fields (Stones)

Die drei Fehlschläge von `mobile-fields` (167/3) waren zunächst eine veraltete Eingabe: Seit dem Stones-Feature (`c098463e`) hat das Telefon für Gold-Diamond kein eigenes Feld für das Diamantgewicht mehr, sondern Steinzeilen. Erst die richtige Eingabe hat dahinter echte Fehler gezeigt:

1. **Handy-Übernahme ohne Normalisierung.**
   - Befund: `createProductWithMedia` (Handy-Weg, jede Anlage mit Fotos) und `editProductWithMedia` (Ändern mit Galerie) schrieben die Steinliste roh, ohne abgeleitetes Diamond Weight.
   - Korrektur: beide normalisieren wie `createProduct` und `updateProduct`. Die Übernahme normalisiert vor Beleg-Hash und Anlage (`withNormalizedStones`), sonst wäre jeder solche Auftrag als `ERR_METADATA_MISMATCH` in Quarantäne gegangen.
   - Produktionskopie: 77 von 80 Gold-Diamond-Artikeln mit Diamant-Karat haben kein gespeichertes Gewicht (nicht geändert).
2. **Anzeige und Druck lasen das Feld direkt.**
   - Befund: Karte, Merkmalliste, Druckzeile und Preisetikett zeigten bzw. druckten dadurch für diese Artikel kein Karat.
   - Korrektur: Sie lesen jetzt über `attributesForDisplay` (Gewicht aus den Diamant-Zeilen, Altwert unverändert), ohne Datenänderung.
3. **Neuladen der Datenbank ohne Steinliste.**
   - Befund: `reloadDbFromDisk` (Onboarding, Schritt 4/5) rief `runMigrations` ohne `migrateCategoryStonesV1`. Bis zum nächsten Start fehlte am Desktop die Steinliste von Gold-Diamond.

## Restrisiken (bewusst nicht über die Oberfläche)

- Galerie-Speichern mit verlorener Antwort und „Zahlung berichtigen" mit verlorener Antwort bzw. altem Stand sind nur auf Befehlsebene bewiesen (Node, echte sql.js-Zeilen). Über die Oberfläche laufen dieselben Mechanismen (Replay über die Kennung, Fassungsprüfung) mit anderen Befehlen (r5b, B1–B6).
- `transfers.mark_settled` ist registriert, hat aber keinen Einstieg in der Oberfläche. Es ist nur auf Befehlsebene geprüft.
- Weiterer Lauf mit derselben toten Kennzeichnung: `c6-release-hardening` (`[data-client-mode]`). Er ist nicht Teil dieser sieben und nicht geändert.
