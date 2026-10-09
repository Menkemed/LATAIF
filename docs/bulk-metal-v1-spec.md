# Bulk Metal V1 — Spezifikation (final)

Stand 08.10.2026, Basis v0.8.79 (`9bcb6d9`). Review eingearbeitet; keine offenen V1-Entscheidungen.
Nur Spezifikation, nichts gebaut, keine Migration ausgeführt.
Alle Pfade relativ zu `desktop/src/`, sofern nicht anders angegeben.

---

## 0. Zweck und Grundsätze

Edelmetall-Ware nach Gewicht: Einkauf als Menge in Gramm zu einem Gesamtpreis (z. B. 500 g Silver 925 für
1,000 BHD), Verkauf einzelner Stücke (z. B. ein Ring zu 7 g) als normale Rechnungszeile; Wareneinsatz
anteilig aus genau diesem Einkauf.

Grundsätze:

1. **Gewicht ist die einzige harte Bestandsgröße.** Stückzahlen und Composition sind Information.
2. **Eine Buchhaltung.** Einkauf, Rechnung, Retoure, Hauptbuch und `stock_lots` werden wiederverwendet; es
   gibt keine zweite Lager- oder Buchungsarchitektur.
3. **Ganze Zahlen.** Gewicht intern in ganzen Milligramm (mg), Werte in ganzen Fils (1 BHD = 1000 Fils).
   Neue Bulk-Eingaben werden als Text exakt in mg/Fils geparst; kein Float in der Bestandsrechnung.
4. **Rechnungszeile bleibt `Qty = 1 pcs`.** Ihr `purchase_price_snapshot` ist exakt der zugewiesene COGS
   der ganzen Zeile. Preis, MwSt und Brutto folgen exakt dem bestehenden Zeilenvertrag des Steuerschemas.
   Damit laufen Margen-MwSt, NBR-Export, COGS-Buchung und Auswertungen unverändert.
5. **Primary ist kanonisch.** PC2 schickt Absicht (Lot, Gewicht, Typ, Preis), der Primary rechnet.
6. **Marktpreis und Einstand sind strikt getrennt.** Purchase Cost/g kommt aus dem Lot, Live Market/g aus
   der Spot-SSOT; nichts davon überschreibt das andere.
7. **Jede manuelle Aktion ist wiederholbar ohne Doppelwirkung** (stabile `action_id`, explizites Replay).

---

## 1. Begriffe

| Begriff | Bedeutung |
|---|---|
| Bulk-Systemartikel | Ein Systemartikel je Metall + Feinheit + Filiale, z. B. „Silver 925 – Bulk". Ohne SKU, ohne Stückmenge, nicht bearbeitbar. |
| Bulk-Lot | Ein `stock_lots`-Eintrag mit `unit = 'mg'`, genau einer je Bulk-Einkaufszeile, Nummer `BM-0001` je Filiale. |
| Restgewicht / Restwert | `remaining_weight_mg` / `remaining_value_fils` des Lots. |
| Original Cost/g | `original_value_fils / original_weight_mg` (nur Anzeige). |
| Current Cost Basis/g | `remaining_value_fils / remaining_weight_mg` (nur Anzeige). |
| Bewegung | Eine Zeile in `bulk_lot_movements`; jede Änderung an Restgewicht, Restwert oder Lot-Gewicht ist genau eine Bewegung. |
| Bulk-Zeile | Rechnungszeile mit `bulk_weight_mg IS NOT NULL`. |
| Manuelle Aktion | Gewicht korrigieren, Write off, Close Lot, Abschreibung stornieren. |
| `action_id` | Stabile Kennung einer manuellen Aktion (eine je Dialog-Absicht), s. 13.6. |

---

## 2. Datenmodell und Migrationen

Alle DDL-Anweisungen kommen in das `runMigrations`-Array in `core/db/database.ts` (dort lebt `stock_lots`,
database.ts:1270-1286; es gibt keine nummerierten Migrationsdateien, jede Anweisung läuft bei jedem Start,
„duplicate column" wird geschluckt, database.ts:2450-2457). Keine Datenmigration nötig: Produktion hat keine
Bulk-Daten.

### 2.1 `stock_lots` erweitern (keine neue Lot-Tabelle)

```sql
ALTER TABLE stock_lots ADD COLUMN unit TEXT NOT NULL DEFAULT 'pcs';      -- 'pcs' | 'mg'
ALTER TABLE stock_lots ADD COLUMN lot_no TEXT;                           -- BM-0001 … je Filiale (nur Bulk)
ALTER TABLE stock_lots ADD COLUMN metal_type TEXT;                       -- gold | silver | platinum
ALTER TABLE stock_lots ADD COLUMN fineness TEXT;                         -- Schlüssel aus METAL_GRADES, z. B. '925', '24K'
ALTER TABLE stock_lots ADD COLUMN original_weight_mg INTEGER;
ALTER TABLE stock_lots ADD COLUMN remaining_weight_mg INTEGER;
ALTER TABLE stock_lots ADD COLUMN original_value_fils INTEGER;
ALTER TABLE stock_lots ADD COLUMN remaining_value_fils INTEGER;
ALTER TABLE stock_lots ADD COLUMN sale_tax_scheme TEXT;                  -- tax_mode-Snapshot: MARGIN | VAT_10 | ZERO
ALTER TABLE stock_lots ADD COLUMN composition_json TEXT;                 -- nur Information, s. 6.3
ALTER TABLE stock_lots ADD COLUMN closed_at TEXT;
ALTER TABLE stock_lots ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE stock_lots ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_lots_lot_no ON stock_lots(branch_id, lot_no) WHERE lot_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_lots_unit_status ON stock_lots(unit, status);
CREATE TRIGGER IF NOT EXISTS trg_stock_lots_revision AFTER UPDATE ON stock_lots
  WHEN NEW.revision = OLD.revision AND NEW.unit = 'mg'
  BEGIN UPDATE stock_lots SET revision = OLD.revision + 1 WHERE id = NEW.id; END;
```

Regeln für Bulk-Lots (`unit = 'mg'`):

- `qty_total = qty_remaining = 0` und `unit_cost = 0`. **Absicht:** Alle bestehenden Stückpfade
  definieren „verfügbar" als `status != 'CANCELLED' AND qty_remaining > 0` (lot-queries.ts:44 ff.). Ein
  Bulk-Lot ist für sie damit immer leer und wird nie per FIFO gewählt, nie stückweise verbraucht, zählt nie
  als Stück. Zusätzlich harte Schutzwände, s. 2.5.
- Bestand und Wert stehen ausschließlich in den vier neuen INTEGER-Spalten.
- `status`: `ACTIVE` | `EXHAUSTED` (Restgewicht 0 durch Verkauf) | `CLOSED` (Rest abgeschrieben) |
  `CANCELLED` (Einkauf storniert). `CLOSED` ist neu; für die Stückpfade ist es wegen `qty_remaining = 0`
  unsichtbar.
- `product_id` = Bulk-Systemartikel; `purchase_id`, `purchase_line_id`, `acquired_at` wie bisher.
- `revision` steigt bei jeder Änderung (Trigger, Muster wie `precious_metals`, database.ts:2208-2215);
  manuelle Aktionen schicken `expectedRevision` (geprüft erst nach dem Replay-Schritt, 13.6).
- `lot_no` ist eindeutig je Filiale (Unique-Index = letzte Schutzwand; Vergabe s. 2.8).

Warum `stock_lots` und keine eigene Tabelle: `invoice_lines.lot_id` zeigt bereits auf `stock_lots`, der
Einkauf legt dort bereits Lots an, Einkaufs-Storno arbeitet bereits auf den Lots eines Einkaufs, und
`stock_lots` steht schon im Sync-Manifest. Die Trennung zu Stücklots leistet `unit`.

### 2.2 `invoice_lines` erweitern

```sql
ALTER TABLE invoice_lines ADD COLUMN bulk_weight_mg INTEGER;   -- verbrauchtes Gewicht; NOT NULL ⇔ Bulk-Zeile
ALTER TABLE invoice_lines ADD COLUMN bulk_cogs_fils INTEGER;   -- zugewiesener COGS der ganzen Zeile
ALTER TABLE invoice_lines ADD COLUMN bulk_type TEXT;           -- RING | BRACELET_BANGLE | NECKLACE_CHAIN | EARRINGS | PENDANT | SET | OTHER | BY_WEIGHT
ALTER TABLE invoice_lines ADD COLUMN bulk_metal TEXT;          -- Snapshot für Anzeige/Audit
ALTER TABLE invoice_lines ADD COLUMN bulk_fineness TEXT;       -- Snapshot für Anzeige/Audit
```

Auf einer Bulk-Zeile gilt immer:

| Spalte | Wert |
|---|---|
| `product_id` | Bulk-Systemartikel |
| `lot_id` | das manuell gewählte Bulk-Lot |
| `quantity` | 1 |
| `stock_taken` | 1 (Ware entnommen; s. 2.5 für die Restore-Pfade) |
| `tax_scheme` | `stock_lots.sale_tax_scheme` des Lots, nicht wählbar |
| `unit_price`, `vat_amount`, `line_total` | exakt wie eine normale Zeile desselben Steuerschemas (7.2) |
| `purchase_price_snapshot` | `bulk_cogs_fils / 1000` (exakt 3 Dezimalen) |
| `description` | Eingabe oder automatisch `Ring · Silver 925 · 7.000 g` |

### 2.3 Neue Tabelle `bulk_lot_movements`

```sql
CREATE TABLE IF NOT EXISTS bulk_lot_movements (
  id                   TEXT PRIMARY KEY,
  branch_id            TEXT NOT NULL,
  lot_id               TEXT NOT NULL REFERENCES stock_lots(id),
  seq                  INTEGER NOT NULL,           -- 1, 2, 3 … je Lot, lückenlos; bestimmt „letzte Bewegung"
  kind                 TEXT NOT NULL CHECK (kind IN (
                         'PURCHASE','WEIGHT_CORRECTION','PURCHASE_CANCEL',
                         'SALE','SALE_REVERSAL','RETURN','RETURN_CANCEL',
                         'WRITE_OFF','CLOSE','ADJUSTMENT_REVERSAL')),
  weight_mg            INTEGER NOT NULL,           -- vorzeichenbehaftet: Zugang +, Abgang −
  value_fils           INTEGER NOT NULL,           -- vorzeichenbehaftet
  weight_after_mg      INTEGER NOT NULL CHECK (weight_after_mg >= 0),
  value_after_fils     INTEGER NOT NULL CHECK (value_after_fils >= 0),
  source_module        TEXT NOT NULL,              -- PURCHASE | INVOICE | SALES_RETURN | STOCK_ADJUST
  source_id            TEXT NOT NULL,              -- purchase_id | invoice_id | return_id | action_id
  source_line_id       TEXT,                       -- purchase_line_id | invoice_line_id
  action_id            TEXT,                       -- nur manuelle Aktionen (= source_id)
  payload_hash         TEXT,                       -- nur manuelle Aktionen: Hash der fachlichen Eingabe
  result_json          TEXT,                       -- nur manuelle Aktionen: eingefrorene Antwort
  reverses_movement_id TEXT REFERENCES bulk_lot_movements(id),  -- nur ADJUSTMENT_REVERSAL
  bulk_type            TEXT,
  reason               TEXT,                       -- Pflicht bei allen manuellen Aktionen
  business_date        TEXT NOT NULL,
  created_by           TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bulk_mov_seq     ON bulk_lot_movements(lot_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bulk_mov_source  ON bulk_lot_movements(kind, source_id, IFNULL(source_line_id, ''));
CREATE UNIQUE INDEX IF NOT EXISTS uq_bulk_mov_action  ON bulk_lot_movements(branch_id, action_id) WHERE action_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bulk_mov_reverses ON bulk_lot_movements(reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bulk_mov_lot ON bulk_lot_movements(lot_id, created_at);
```

Zweck: Audit-Trail (wer, wann, warum), Idempotenz (ein Beleg bewegt ein Lot nur einmal; eine manuelle
Aktion wirkt nur einmal; eine Abschreibung wird höchstens einmal storniert), Reihenfolge („letzte
Bewegung" = höchste `seq`) und Invariantenprüfung (Lot = Summe seiner Bewegungen).

Die Unique-Indizes sind **Schutzwände**, kein Ersatz für das explizite Replay der manuellen Aktionen (13.6).

### 2.4 Neue Tabelle `bulk_lot_sequences` (Lot-Nummern)

```sql
CREATE TABLE IF NOT EXISTS bulk_lot_sequences (
  branch_id   TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL,
  updated_at  TEXT NOT NULL
);
```

Eigener Zähler; `sku_sequences` ist nur Architekturvorbild. Dessen Kollisionsprüfung läuft gegen
`products.sku` (sku-sequence.ts:88) und ist für Lot-Nummern falsch. Die Tabelle wird nicht synchronisiert
(Lots entstehen nur auf dem Primary); der Algorithmus 2.8 heilt einen verlorenen oder zu niedrigen Zähler
selbst.

### 2.5 Schutzwände in bestehendem Code

| Stelle | Regel |
|---|---|
| `consumeLot`, `restoreLot` (lot-queries.ts:128, 187) | werfen `BULK_LOT_PIECE_PATH`, wenn `unit = 'mg'` (sonst würde `restoreLot` ein EXHAUSTED/CLOSED-Lot auf ACTIVE setzen). |
| `getActiveLots`, `getLotsWithPurchaseNumbers`, FIFO-SQL in invoiceStore.ts:311-323 und :794, invoice-command.ts:228-258, agentStore.ts:409-412 | zusätzlich `AND unit = 'pcs'`. |
| `getStockAggregates`, `computeStockValuation`, `summarizeInventory`, `syncProductQuantity`, `lotAggregatesFor` (domain-reads.ts:75-84) | nur `unit = 'pcs'`; Bulk-Artikel werden übersprungen. |
| `reconcileSaleStatus`, `reserveProductIfDepleted`, `unreserveProductIfRestored` | früher Ausstieg für `bulk-`-Artikel (wie `svc-repair-`, lot-queries.ts:320). |
| Alle Restore-/Retake-Pfade (Liste 8.4, 9.3) | verzweigen vorher auf `isBulkLine(line)` → Bulk-Funktionen. |
| Produkt-Bearbeiten/-Löschen, Kategorie-Bearbeiten (Liste 3.2) | `BULK_SYSTEM_PRODUCT_LOCKED`. |

### 2.6 Sync-Manifest

`core/sync/sync-business-schema.json` ist die Allowlist für den Sync; der Drift-Test
`test/m6b3a/manifest-drift.test.ts` verlangt, dass jede Spalte aus `database.ts` dort steht und jede
`track*('tabelle'`-Stelle eine Tabelle im Manifest hat. Daher:

- `stock_lots`: die 13 neuen Spalten aufnehmen.
- `invoice_lines`: die 5 neuen Spalten aufnehmen (Tabelle erlaubt weiter nur insert/delete; Bulk-Felder
  ändern sich nie nach dem Insert).
- `bulk_lot_movements`: neue Tabelle, nur insert.
- `bulk_lot_sequences`: nicht im Manifest (kein `track*`-Aufruf).

### 2.7 Konto

Ledger-Konto `INVENTORY_LOSS` (Aufwand, Soll-Natur), Quellmodul `STOCK_ADJUST` (deklariert, bisher
ungenutzt, posting.ts:127).

### 2.8 Lot-Nummer `BM-0001` je Filiale

`allocateBulkLotNo(branchId)` läuft **in derselben Primary-Transaktion** wie der Einkauf:

1. `n0 = bulk_lot_sequences.next_number` der Filiale (fehlt die Zeile: 1).
2. `n1 = 1 + MAX(CAST(SUBSTR(lot_no, 4) AS INTEGER))` über `stock_lots` der Filiale mit `lot_no LIKE 'BM-%'`
   (keine: 1).
3. `n = max(n0, n1)`; solange `stock_lots(branch_id, 'BM-' || pad4(n))` existiert: `n = n + 1`.
4. `bulk_lot_sequences.next_number = n + 1` (Upsert), Ergebnis `BM-` + mindestens 4 Stellen (`BM-0001`,
   …, `BM-9999`, `BM-10000`).

Ein Einkauf mit mehreren Bulk-Zeilen vergibt fortlaufende Nummern. Rollt der Einkauf zurück, rollt auch der
Zähler zurück (keine verbrauchte Nummer). Schreibvorgänge laufen auf dem Primary exklusiv; der Unique-Index
`uq_stock_lots_lot_no` ist die letzte Schutzwand.

---

## 3. Bulk-Systemartikel

### 3.1 Anlage und Felder

- Id: `bulk-<metal>-<fineness>-<branchId>`, z. B. `bulk-silver-925-branch-main`. Kategorie
  `cat-bulk-metal-<branchId>`. Beide werden beim ersten Bulk-Einkauf dieser Kombination in derselben
  Transaktion angelegt (`INSERT OR IGNORE`, Muster repairStore.ts:358-378).
- Felder: Name `Silver 925 – Bulk`, **`sku = NULL`** (kein normaler SKU), `stock_status = 'in_stock'`
  (bleibt immer so), `source_type = 'OWN'`, `purchase_price = 0`, `quantity = 0`,
  `attributes = {"metal":"silver","fineness":"925"}`. `tax_scheme` am Artikel wird nie benutzt.
  Begründung SKU: `products.sku` ist ohne Datenbank-Eindeutigkeit; die Vergabe prüft filialübergreifend
  (sku-sequence.ts:88), `isSkuTaken` je geladene Filiale (productStore.ts:1449). Ein fester Text-SKU würde
  zwischen Filialen kollidieren und in Vergabe, Dubletten, Import und Handy-Suche auftauchen.
- Zulässige Kombinationen nur aus `METAL_GRADES` (core/gold/purity.ts:56); `metalPurity(metal, fineness)`
  darf nicht `null` sein.
- Helfer (neu, `core/bulk/bulk-product.ts`): `isBulkMetalProduct(id)`, `bulkProductId(metal, fineness,
  branch)`, `BULK_CATEGORY_PREFIX = 'cat-bulk-metal'`, SQL-Fragment `BULK_PRODUCT_EXCLUSION`.
- Der Artikel ist **nie** direkt verkäuflich: Eine Rechnungszeile mit `bulk-`-Artikel ohne Bulk-Felder wird
  mit `BULK_PRODUCT_DIRECT_SALE` abgewiesen.

### 3.2 Harte Sperre gegen normales Bearbeiten und Löschen

Nur die Bulk-Hausfunktionen schreiben den Systemartikel (einmalige Anlage). Alle normalen Pfade lehnen ab
(`BULK_SYSTEM_PRODUCT_LOCKED`), lokal und fern:

| Pfad | Stelle |
|---|---|
| Produkt bearbeiten | `productStore.updateProduct` (productStore.ts:1199), Fernbefehl `products.update` (product-commands.ts:599) |
| Produkt löschen | `productStore.deleteProduct` (:1269), `deleteProducts` (:1291, als `blocked` mit Grund) |
| Kategorie bearbeiten | `productStore.updateCategory` (:1397) und Kategorie-Verwaltung in den Einstellungen für `cat-bulk-metal-*` |
| Excel-Import | Systemartikel nicht im Abgleich-Index, Kategorie nicht wählbar (product-import.ts:178, ImportPage.tsx:393) |

---

## 4. Rechenregeln

### 4.1 Eingaben (nur exaktes Text→Integer-Parsing)

- `parseGramsToMg(text)`: erlaubt `^\d+(\.\d{1,3})?$` (keine Tausendertrennzeichen, kein Exponent, kein
  Vorzeichen); `"7"` → 7000, `"7.5"` → 7500, `"7.500"` → 7500; 0, mehr als 3 Dezimalen oder anderes
  Format → `BULK_WEIGHT_INVALID`.
- `parseBhdToFils(text)`: gleiches Format; `"25"` → 25000, `"1000.000"` → 1000000; sonst
  `BULK_AMOUNT_INVALID`.
- Die Zerlegung erfolgt über die Zeichenkette (Ganzteil × 1000 + rechts mit Nullen aufgefüllter
  Dezimalteil). **Kein** `Math.round(float × 1000)` auf neuen Bulk-Eingaben.
- PC2 schickt `weightMg` und Beträge bereits als ganze Zahlen; der Primary prüft `Number.isSafeInteger` und
  > 0.
- Anzeige aus Integern: `formatMg(mg)` / `formatFils(fils)` (Ganzteil und 3-stelliger Rest per
  Ganzzahl-Division, keine Float-Division).
- Rückumrechnung gespeicherter 3-Dezimal-REAL-Beträge (nur in Invariantenprüfungen, nie für Eingaben):
  `filsOfStoredAmount(n)` prüft `|n·1000 − round(n·1000)| < 1e-6`, sonst Fehler.

### 4.2 Zuteilung (Verkauf und Teil-Abschreibung)

```
gegeben: V = remaining_value_fils, W = remaining_weight_mg, w = entnommenes Gewicht (1 ≤ w ≤ W)
wenn w == W:  anteil = V                                  (letzter Verbrauch nimmt exakt den Rest)
sonst:        anteil = floor((2·V·w + W) / (2·W))         (kaufmännisch gerundet, half-up)
danach:       V' = V − anteil,  W' = W − w
```

- Rechnung mit `BigInt` (V·w kann 2^53 übersteigen: 100.000 BHD × 100 kg = 10^8 · 10^8).
- Es wird nie mit `unit_cost × Gewicht` gerechnet; die Zuteilung folgt immer dem **aktuellen** Restwert.
  Rundungen verteilen sich so über die Lebensdauer, und der letzte Verbrauch gleicht exakt aus.
- `W' > 0` mit `V' = 0` ist zulässig (nach Rundung möglich, dann COGS 0 für den Rest); `W' = 0` mit
  `V' > 0` ist unmöglich.

### 4.3 Rückgabe (Retoure, Zeile entfernen, Storno, Abschreibung stornieren)

Rückgabe bucht **exakt** die gespeicherten Werte zurück (`+bulk_weight_mg`, `+bulk_cogs_fils` bzw. die
Werte der stornierten Bewegung). Keine Neuberechnung.

### 4.4 Wieder-Entnahme (Retoure stornieren)

Entnimmt exakt `bulk_weight_mg` und `bulk_cogs_fils`. Zulässig nur wenn danach `W' ≥ 0`, `V' ≥ 0` und
(`W' = 0 ⇒ V' = 0`). Sonst `RETURN_STOCK_RESOLD` (bestehender Code, return-cancel-house.ts:287-304): die
retournierte Ware ist faktisch weiterverkauft.

### 4.5 Einkaufswert in Fils

Für eine Bulk-Einkaufszeile mit Betrag `L` (Fils, aus `parseBhdToFils`) und Satz `r` (0 oder 10):
`vat_fils = floor((2·L·r + (100 + r)) / (2·(100 + r)))` (half-up), `original_value_fils = L − vat_fils`.
Gespeichert werden `line_total = L/1000` und `vat_amount = vat_fils/1000` (bei Bulk-Zeilen bereits auf
3 Dezimalen; Stückzeilen bleiben wie heute). `postPurchaseReceived` rechnet daraus mit
`capitalizedLineCost` exakt `(L − vat_fils)/1000` — Lot-Wert und INVENTORY-Soll sind dieselbe Zahl.

---

## 5. Invarianten

Zu jedem Zeitpunkt, nach jeder Transaktion:

**Je Lot L (`unit = 'mg'`):**

1. `remaining_weight_mg ≥ 0`, `remaining_value_fils ≥ 0`.
2. `remaining_weight_mg = 0 ⇒ remaining_value_fils = 0`.
3. `remaining_weight_mg = Σ weight_mg` und `remaining_value_fils = Σ value_fils` aller Bewegungen von L;
   `seq` lückenlos 1…n; `weight_after_mg`/`value_after_fils` der letzten Bewegung = Lot-Stand.
4. `original_value_fils` = `value_fils` der PURCHASE-Bewegung; `original_weight_mg` = `weight_mg` der
   PURCHASE-Bewegung + Σ WEIGHT_CORRECTION. Daraus mit 3: Restwert = Original + Σ `value_fils` aller
   übrigen Bewegungen (SALE, SALE_REVERSAL, RETURN, RETURN_CANCEL, WRITE_OFF, CLOSE, ADJUSTMENT_REVERSAL,
   PURCHASE_CANCEL; vorzeichenbehaftet).
5. Status passt: `ACTIVE` ⇔ Restgewicht > 0 (außer `CANCELLED`); `EXHAUSTED`/`CLOSED` ⇒ Restgewicht 0;
   `closed_at` gesetzt ⇔ `CLOSED`.
6. `qty_total = qty_remaining = unit_cost = 0`.
7. Je Bulk-Rechnungszeile: `purchase_price_snapshot × 1000 = bulk_cogs_fils`, `quantity = 1`,
   `tax_scheme = sale_tax_scheme` des Lots.
8. Composition-Summe ≤ `original_weight_mg`.
9. „Sold as" gesamt (12.1) = −(Σ weight_mg aus SALE, SALE_REVERSAL, RETURN, RETURN_CANCEL) des Lots.

**Hauptbuch:**

10. Je Bewegung gibt es die passende INVENTORY-Buchung mit exakt `|value_fils| / 1000`:
    PURCHASE ↔ `PURCHASE`/purchase_line_id (Soll), SALE ↔ `INVOICE`/invoice_line_id (Haben, COGS-Paar),
    RETURN ↔ `SALES_RETURN_COGS`/invoice_line_id (Soll), WRITE_OFF/CLOSE ↔ `STOCK_ADJUST`/action_id
    (Haben), alle Rücknahmen ↔ die Gegenbuchung (`reverses_entry_id`). Bewegungen mit `value_fils = 0`
    (auch WEIGHT_CORRECTION) haben keine Buchung.
11. Daraus: `Σ remaining_value_fils aller Bulk-Lots / 1000 = Bulk-Anteil des INVENTORY-Kontos`
    (Summe der INVENTORY-Buchungen, die über `source_line_id`/`source_id` an Bulk-Quellen hängen).
    Dieser Wert ist der „Bulk Metal Inventory value" in allen Auswertungen.

Prüffunktion `assertBulkLotInvariants(lotId)` läuft am Ende jeder Bulk-Hausfunktion **in** der Transaktion
(Verstoß → Rollback). Eine Gesamtprüfung `bulkLedgerReconciliation(branchId)` kommt als Test und als
Diagnosezeile auf die Bulk-Seite.

---

## 6. Einkauf

### 6.1 Ablauf (bestehender Pfad)

`PurchaseCreate.tsx` → `createPurchaseOnPrimary` (purchase-house.ts:173) → `planPurchaseCreate`
(purchase-create.ts:176) → `usePurchaseStore.createPurchase` (purchaseStore.ts:349-600); PC2 über
`purchases.create` (commercial-commands.ts:88, 457). Es gibt keinen Entwurf: Lots entstehen beim Speichern
(purchaseStore.ts:502-525). Es gibt keine Einkaufsbearbeitung.

Neu ist nur ein dritter Zeilenmodus neben `existing`/`new`: **`bulk`**.

### 6.2 Eingabe einer Bulk-Zeile

| Feld | Pflicht | Regel |
|---|---|---|
| Metall | ja | gold / silver / platinum |
| Feinheit | ja | aus `METAL_GRADES[metal]` |
| Gesamtgewicht (g) | ja | `parseGramsToMg` |
| Gesamtkosten (BHD) | ja | `parseBhdToFils`; Zeilenbetrag wie bei jeder Einkaufszeile (brutto bei VAT_10) |
| Steuerart beim Verkauf | ja | `MARGIN` / `VAT_10` / `ZERO`; Vorschlag aus der Einkaufs-Steuerart (ZERO → MARGIN, VAT_10 → VAT_10); welche fachlich gilt, bestimmt die bestehende Steuerregel des Hauses |
| Composition | nein | Zeilen `{Typ, Gewicht g, ca. Stück}` |
| Notiz | nein | |

Anzeige während der Eingabe: **Purchase Cost/g** = `original_value_fils / Gewicht` (bei VAT_10 ohne
Vorsteuer, 4.5). Daneben getrennt und beschriftet: **Live Market/g** = `bhdPerGramFine(usd/oz) ×
metalPurity(metal, fineness)` (nur Referenz).

### 6.3 Was gespeichert wird (eine Transaktion)

1. Bulk-Systemartikel sicherstellen (Kapitel 3).
2. `purchase_lines`: `product_id = bulk-…`, `quantity = 1`, `unit_price = line_total = L/1000`,
   `tax_scheme`/`vat_rate` wie jede Zeile des Einkaufs, `vat_amount = vat_fils/1000`,
   `description = "Silver 925 · 500.000 g (bulk)"`.
3. Lot-Nummer `allocateBulkLotNo` (2.8).
4. `stock_lots`: `unit='mg'`, `lot_no`, `metal_type`, `fineness`, `original/remaining_weight_mg = W`,
   `original/remaining_value_fils = L − vat_fils`, `sale_tax_scheme`, `composition_json`, `qty_* = 0`,
   `unit_cost = 0`, `status='ACTIVE'`.
5. Bewegung `PURCHASE` (seq 1, +W, +V, source PURCHASE/purchase_id/purchase_line_id).
6. Hauptbuch unverändert über `postPurchaseReceived` (posting.ts:1247-1304): Soll INVENTORY
   `capitalizedLineCost`, Soll VAT_INPUT, Haben ACCOUNTS_PAYABLE brutto.
7. **Pflicht:** Für Einkäufe mit Bulk-Zeilen bricht ein Buchungsfehler die Transaktion ab
   (`watchLedgerPosts` wie Rechnung/Retoure). Heute läuft `postPurchaseReceived` über `safePost`, das
   Fehler schluckt (purchaseStore.ts:49-53, 573-577).

Composition-Regeln: `composition_json = [{"type":"RINGS","weightMg":180000,"pieces":30}, …]`; Typen
`RINGS, BRACELETS_BANGLES, NECKLACES_CHAINS, EARRINGS, PENDANTS, SETS, MIXED_OTHER`; Gewicht per
`parseGramsToMg`; Summe ≤ Gesamtgewicht (sonst `BULK_COMPOSITION_EXCEEDS_WEIGHT`), der Rest wird als
„Unassigned" angezeigt. Composition wird nie fortgeschrieben, nie skaliert und blockiert nie einen Verkauf.
Änderbar nur zusammen mit der Gewichtskorrektur eines unbenutzten Lots (6.5).

### 6.4 Lieferanten, Zahlung, Partner

- Lieferant, Zahlung, Lieferantenkredit, Vorsteuer: unverändert (payables-house.ts, `postPurchasePayment`).
- Partnerbeteiligung (`PartnerItemsPanel`) für Bulk-Zeilen gesperrt (`BULK_NOT_SUPPORTED_HERE`).
- Rückgabe an den Lieferanten (`returnToSupplierInHouse`, purchase-lifecycle-house.ts:490) für Bulk-Zeilen
  gesperrt (nicht in V1).

### 6.5 Einkauf stornieren / Lot korrigieren

- **Einkauf stornieren** (`cancelPurchaseInHouse`, purchase-lifecycle-house.ts:703-838): zulässig nur, wenn
  jedes Bulk-Lot des Einkaufs nur `PURCHASE`/`WEIGHT_CORRECTION`-Bewegungen hat (sonst
  `BULK_LOT_IN_USE`). Dann: Bewegung `PURCHASE_CANCEL` (−W, −V), Lot `CANCELLED`, Hauptbuch über das
  bestehende `postPurchaseCancelled`.
- **Lot korrigieren** (manuelle Aktion `bulk_metals.correct_weight`, Dialog mit Gewicht **und**
  Composition):
  - zulässig nur, solange das Lot nur `PURCHASE`/`WEIGHT_CORRECTION`-Bewegungen hat (sonst
    `BULK_LOT_IN_USE`);
  - neues Gewicht > 0, beide Richtungen; `original_weight_mg = remaining_weight_mg = neu`; der Wert bleibt
    unverändert;
  - die Composition ist im selben Dialog änderbar; nach der Aktion muss gelten `Composition-Summe ≤ neues
    Gewicht`, sonst `BULK_COMPOSITION_EXCEEDS_WEIGHT`. **Nie automatisch skalieren**;
  - Gewicht und Composition dürfen auch einzeln geändert werden (gleiche Aktion);
  - Bewegung `WEIGHT_CORRECTION` (±Δw, 0) mit `result_json` = Gewicht und Composition vorher/nachher;
    Pflichtgrund, `action_id`, `expectedRevision`.
- Nach dem ersten Verkauf, der ersten Retoure oder Abschreibung gibt es **keine** Erhöhung mehr; eine
  Verringerung nur als Write-off; die Composition ist dann eingefroren.
- **Kosten falsch erfasst:** Einkauf stornieren und neu erfassen (nur solange unbenutzt), da es keine
  Einkaufsbearbeitung gibt.

---

## 7. Verkauf (nur über Rechnung)

### 7.1 Ablauf (bestehender Pfad)

`InvoiceCreate.tsx` → `invoices.create` (`createInvoiceOnPrimary`, invoice-create-house.ts:186-189; PC2
invoice-command.ts:324-392) → `createDirectInvoice` (invoiceStore.ts:265-436). Rechnungen entstehen als
`PARTIAL`; **Bestand und COGS werden bei Anlage gebucht**, nicht bei FINAL (invoiceStore.ts:381-404,
posting.ts:550-557). Das gilt unverändert für Bulk-Zeilen.

### 7.2 Eingabe („Add bulk metal" in der Rechnungsmaske) und Preisvertrag

| Feld | Pflicht | Regel |
|---|---|---|
| Bulk-Artikel | ja | Metall + Feinheit mit mindestens einem aktiven Lot |
| Lot | ja | **manuell**; Liste zeigt `lot_no`, Einkaufsdatum, Restgewicht, Current Cost Basis/g, Steuerart |
| Typ | ja | Ring, Bracelet/Bangle, Necklace/Chain, Earrings, Pendant, Set, Other, By weight |
| Gewicht (g) | ja | `parseGramsToMg`, 0 < w ≤ Restgewicht |
| Preis | ja | `parseBhdToFils`; Bedeutung exakt wie das Preisfeld einer normalen Zeile desselben Steuerschemas |
| Beschreibung | nein | sonst automatisch `<Typ> · <Metal> <Feinheit> · <g mit 3 Dezimalen> g` |

**Preisvertrag: keine eigene Bulk-Semantik.** Der eingegebene Preis ist der `unitPrice` des bestehenden
Zeilenvertrags (`toInvoiceLine`/`calcInvoiceLine`, line-derivation.ts:37-93; vat-engine.ts:113-154), Menge
fest 1, `purchasePrice = bulk_cogs_fils/1000`. Je Steuerschema bedeutet das, genau wie bei einer
normalen Zeile:

| Steuerart des Lots | Eingegebener Preis | MwSt | Kunde zahlt (`line_total`) |
|---|---|---|---|
| MARGIN | Kundenbetrag (Netto = Brutto) | intern `max(0, Preis − COGS) × 10/110`, nicht ausgewiesen | Preis |
| VAT_10 | Netto | `Preis × 10 %`, ausgewiesen | Preis + 10 % |
| ZERO | Kundenbetrag | 0 | Preis |

Nur Anzeige: zugewiesener COGS (Vorschau vom Primary), Preis/g, Marge, Live Market Value =
`g × bhdPerGramFine × metalPurity`. Mengenfeld und Steuerart-Auswahl gibt es für Bulk-Zeilen nicht; die
Steuerart wird aus dem Lot angezeigt.

### 7.3 Was der Primary in der Transaktion tut

1. Lot laden, prüfen: `unit='mg'`, Filiale, Status `ACTIVE`, `w ≤ remaining_weight_mg`.
2. `cogs = allocate(V, W, w)` (4.2).
3. Zeile über den bestehenden Zeilenvertrag (7.2) bilden; `purchase_price_snapshot = cogs/1000`,
   `tax_scheme = sale_tax_scheme`, Bulk-Spalten setzen.
4. Lot fortschreiben, Bewegung `SALE` (−w, −cogs, source INVOICE/invoice_id/line_id), Status `EXHAUSTED`
   wenn W' = 0.
5. Hauptbuch unverändert `postInvoiceIssued` (posting.ts:561-639): COGS = `ROUND(snapshot × max(1,1))` =
   exakt cogs.
6. `assertBulkLotInvariants`.

Der Verbrauch des Bulk-Lots läuft **nicht** über `takeStock`/`consumeLot`, sondern über die neue
Hausfunktion `consumeBulk` (`core/bulk/bulk-lot-house.ts`).

### 7.4 Was der Kunde sieht

Rechnung (A5, `core/pdf/invoice-a5.ts:204-257`), Browser-Beleg (InvoiceDetail.tsx:1341-1400), Gutschrift,
NBR-Export: Beschreibung der Zeile (nicht der Artikelname „Silver 925 – Bulk"), Menge `1 pcs`, Preis, MwSt
nach Steuerart. **Nie** Lot-Nummer, COGS oder Einstand; der Systemartikel hat keinen SKU, eine SKU-Zeile
entfällt. Der Margen-Hinweis erscheint wie bisher bei MARGIN.

Intern (InvoiceDetail, nur Mitarbeiter): Bulk-Badge mit Lot-Nummer, Gewicht, COGS; Link zur Lot-Ansicht
statt zur Produktseite.

### 7.5 Andere Wege, Rechnungszeilen zu erzeugen

Angebot → Rechnung (offer-house.ts:472-515), Auftrag → Rechnung (order-invoice-lines.ts:49-119),
Kommission (consignmentStore.ts:530), Reparaturrechnung (repairStore.ts:1171), Agenten-Übergabe
(agentStore.ts:659, 791): Bulk-Artikel sind in den Auswahlen ausgeblendet; die Server-Gates weisen
`bulk-`-Artikel mit `BULK_NOT_SUPPORTED_HERE` ab.

---

## 8. Rechnung ändern, stornieren, löschen

### 8.1 Ändern (`editInvoice`, invoiceStore.ts:617-1108; PC2 `invoices.update`)

- Bestehende Bulk-Zeile: **Lot, Gewicht und COGS gesperrt** (`BULK_LINE_FIELDS_LOCKED`). Preis, Typ und
  Beschreibung bleiben änderbar (Preis nach den bestehenden Regeln, z. B. nicht bei retournierten Zeilen,
  edit-lines.ts:162-209). Eine Typänderung wirkt auf „Sold as" (12.1).
- Korrektur von Lot/Gewicht: Zeile entfernen und neu anlegen (gleiche oder spätere Bearbeitung).
- Reihenfolge in einer Bearbeitung: **erst** alle entfernten Bulk-Zeilen zurückgeben, **dann** neue
  Bulk-Zeilen entnehmen. So kann dieselbe Ware aus einem gerade erschöpften Lot neu erfasst werden.
- Entfernen: `restoreBulk` mit exakt `+bulk_weight_mg`, `+bulk_cogs_fils`, Bewegung `SALE_REVERSAL`
  (source INVOICE/invoice_id/line_id); ein erschöpftes oder geschlossenes Lot wird `ACTIVE`, `closed_at`
  wird geleert.
- Hauptbuch unverändert: `reverseSource('INVOICE')` und Neubuchung (invoiceStore.ts:721-723, 916-937);
  behaltene Bulk-Zeilen behalten Id und Snapshot, der COGS wird gleich neu gebucht.
- VAT-Sperre unverändert (Fingerabdruck enthält `purchase_price_snapshot`, vat-period-lock.ts:90-123).

### 8.2 Stornieren (`cancelInvoiceInHouse`, invoice-cancel-house.ts:53-144)

- Ohne Zahlung: `updateInvoice(CANCELLED)` gibt Bestand zurück (invoiceStore.ts:500-515) → Bulk-Zweig
  `restoreBulk`, Bewegung `SALE_REVERSAL`; Hauptbuch `reverseSource('INVOICE')`.
- Mit Zahlung: der bestehende Weg erzeugt eine IN_STOCK-Retoure über die Restmenge (84-116) → Bulk-Zeile
  läuft durch Kapitel 9 (Menge 1); danach überspringt `updateInvoice` die Rückgabe, weil eine Gutschrift
  existiert (495-496). Kein doppeltes Zurückbuchen.

### 8.3 Löschen (`deleteInvoice`, invoiceStore.ts:1386-1539, nur Primary)

Wie Stornieren ohne Zahlung: `restoreBulk`, Bewegung `SALE_REVERSAL`. Die Bewegung behält Rechnungs- und
Zeilen-Id als Text (kein Fremdschlüssel), damit der Audit-Trail die gelöschte Rechnung nennt.

### 8.4 Alle Stellen, die verzweigen müssen

`createDirectInvoice` (invoiceStore.ts:336-404), `updateInvoice` (500-515), `editInvoice` (755-772,
784-806, 849-859, 891-897), `deleteInvoice` (1443-1449), `buildInvoiceLines` (invoice-command.ts:194-272),
`invoices.update` (invoice-lifecycle-commands.ts:200-262), `invoiceStockLines`/Legacy-Klassifizierer
(stock-contract.ts:123, 146), `assertLotsConsumable`/`assertLotTrackedLinesResolved`/
`assertProductsSellable` (Bulk-Zeilen eigene Prüfung).

---

## 9. Retoure und Retoure-Storno

### 9.1 Retoure anlegen (`createReturnInHouse`, return-house.ts; PC2 `returns.create`)

- Bulk-Zeile nur **ganz**: Rückgabemenge muss exakt 1 sein (`BULK_RETURN_WHOLE_LINE_ONLY`). Heute sind
  Teilmengen und Bruchteile erlaubt (salesReturnStore.ts:352-377).
- Disposition muss `IN_STOCK` sein (`BULK_RETURN_DISPOSITION`). Ein beschädigter Ring wird retourniert und
  danach per Write-off abgeschrieben.
- Preis und MwSt der Retoure wie heute aus der Rechnungszeile (return-lines.ts:33-46).

### 9.2 Was passiert

- `applyDisposition` IN_STOCK (salesReturnStore.ts:159-171) → Bulk-Zweig `restoreBulk(lot_id,
  +bulk_weight_mg, +bulk_cogs_fils)`, Bewegung `RETURN` (source SALES_RETURN/return_id/invoice_line_id).
  Ein erschöpftes **oder geschlossenes** Lot wird `ACTIVE`, `closed_at` wird geleert (die Schließung bleibt
  als Bewegung im Verlauf).
- COGS-Rückbuchung unverändert `postSalesReturnCogs` (posting.ts:710-746): Original-COGS der Zeile aus dem
  Hauptbuch × 1/1 = exakt `bulk_cogs_fils`. Soll INVENTORY / Haben COGS.
- Gutschrift, Erstattung, Kundenguthaben unverändert (`postCreditNote`, posting.ts:875-974).
- **Pflicht:** `postSalesReturnCogs` ist heute in try/catch ohne eigene Idempotenz (salesReturnStore.ts:
  415-423). Für Bulk-Zeilen gilt: Buchungsfehler bricht ab (`watchLedgerPosts`, return-house.ts:108,
  130) und die Bewegung (Unique-Index) verhindert doppeltes Zurücklegen.

### 9.3 Retoure stornieren (`cancelReturnInHouse`, return-cancel-house.ts:227-482)

- `revertDisposition` IN_STOCK (137-199) → Bulk-Zweig `retakeBulk` mit Prüfung 4.4; sonst
  `RETURN_STOCK_RESOLD`.
- Bewegung `RETURN_CANCEL` (−w, −cogs); Status `EXHAUSTED` wenn W' = 0.
- Hauptbuch unverändert `reverseSource('SALES_RETURN_COGS', returnId)` (331-334).
- Rechte, Grund, Audit wie heute (nur Inhaber, Grund Pflicht).

---

## 10. Write-off, Close Lot, Abschreibung stornieren

| Aktion | Eingabe | Wert | Bewegung | Status |
|---|---|---|---|---|
| **Write off X g** | X (`parseGramsToMg`), Grund, Geschäftsdatum, `action_id`, `expectedRevision` | `allocate(V, W, X)`; bei X = W als Close ausgeführt | `WRITE_OFF` (−X, −wert) | bleibt `ACTIVE` |
| **Close Lot / Write off remaining stock** | Grund, Geschäftsdatum, `action_id`, `expectedRevision`, angezeigter Rest zur Bestätigung | exakt V | `CLOSE` (−W, −V) | `CLOSED`, `closed_at` gesetzt |
| **Abschreibung stornieren** | Ziel-Bewegung, Grund, `action_id`, `expectedRevision` | exakt `−weight_mg`, `−value_fils` der Ziel-Bewegung | `ADJUSTMENT_REVERSAL` (+), `reverses_movement_id` | `ACTIVE`; bei CLOSE `closed_at = NULL` |

Regeln Abschreibung stornieren:

- Nur **ADMIN** (`isOwner`).
- Ziel muss die **letzte Bewegung des Lots überhaupt** sein (höchste `seq`) und `kind ∈ {WRITE_OFF,
  CLOSE}`; sonst `BULK_REVERSAL_NOT_LAST`. Nach einem späteren Verkauf, einer Retoure oder jeder anderen
  Bewegung ist eine Abschreibung nicht mehr stornierbar.
- Eine Bewegung wird höchstens einmal storniert (`uq_bulk_mov_reverses`); eine `ADJUSTMENT_REVERSAL` ist
  selbst nicht stornierbar. Nach einer Stornierung ist die letzte Bewegung die Stornierung; eine frühere
  Abschreibung wird dadurch nicht stornierbar.
- Lot-Stand danach exakt wie vor der Ziel-Bewegung.

Hauptbuch:

- Write-off/Close: neue Funktion `postBulkWriteOff` — Soll `INVENTORY_LOSS` / Haben `INVENTORY`,
  Quellmodul `STOCK_ADJUST`, `source_id = action_id`, `metadata = {lotId, lotNo, weightMg, reason}`.
  Wert 0 → keine Buchung.
- Stornieren: `reverseSource('STOCK_ADJUST', ziel.action_id)` — exakter Spiegel (Soll INVENTORY / Haben
  INVENTORY_LOSS); ohne Originalbuchung (Wert 0) keine Buchung.
- **Kein COGS**, keine automatische MwSt-Korrektur (auch nicht bei VAT_10-Lots).

Geschäftsdatum über `businessDateIssue` (core/utils/business-date.ts:27), keine Zukunft. Close auf einem
Lot mit Restgewicht 0 ist nicht möglich.

---

## 11. Hauptbuch

### 11.1 Neues Konto `INVENTORY_LOSS`

Stellen, die es kennen müssen:

- `LedgerAccount` (posting.ts:44-100).
- `NATURAL_DEBIT` (core/ledger/queries.ts:31-55) — sonst dreht `balanceOf` das Vorzeichen.
- `ALL_ACCOUNTS` + Beschriftung (pages/settings/LedgerDebugPage.tsx:52-66).
- Gewinn-Anzeigen: Auswertungen rechnen Gewinn aus Fachtabellen, nicht aus dem Hauptbuch
  (analytics-snapshot.ts, BusinessReportsPage.tsx:296-316). Dort eine eigene Zeile „Inventory loss (bulk
  metal)" = Σ `value_fils` der Bewegungen WRITE_OFF + CLOSE + ADJUSTMENT_REVERSAL im Zeitraum (nach
  `business_date`, Vorzeichen umgedreht), vom Gewinn abgezogen.

### 11.2 Buchungen je Vorgang (alle über bestehende Funktionen außer Write-off)

| Vorgang | Funktion | Soll | Haben |
|---|---|---|---|
| Einkauf ZERO | `postPurchaseReceived` | INVENTORY V | AP V |
| Einkauf VAT_10 | `postPurchaseReceived` | INVENTORY netto, VAT_INPUT | AP brutto |
| Verkauf | `postInvoiceIssued` | AR brutto; COGS cogs | REVENUE; VAT_OUTPUT bzw. MARGIN_VAT; INVENTORY cogs |
| Zeile entfernen / Storno / Löschen | `reverseSource('INVOICE')` (+ Neubuchung bei Edit) | Spiegel | Spiegel |
| Retoure | `postCreditNote` + `postSalesReturnCogs` | REVENUE, MwSt; INVENTORY cogs | AR/Kasse/Guthaben; COGS cogs |
| Retoure-Storno | `reverseSource` je Quelle | Spiegel | Spiegel |
| Write-off / Close | `postBulkWriteOff` (neu) | INVENTORY_LOSS | INVENTORY |
| Abschreibung stornieren | `reverseSource('STOCK_ADJUST', action_id)` | INVENTORY | INVENTORY_LOSS |
| Einkauf storniert | `postPurchaseCancelled` | Spiegel | Spiegel |
| Lot korrigieren | — | — | — |

---

## 12. Bulk-Metals-Ansicht, Ausblenden und Einbeziehen

### 12.1 Neue Seite `/bulk-metals` (Sidebar-Eintrag in `components/layout/Sidebar.tsx:21-82`)

- Hinweisleiste: „Bulk Metals führt verkaufsfähige Ware nach Gewicht. Barren und Einzelposten bleiben in
  Precious Metals. Dieselbe Ware nie in beiden Modulen erfassen."
- Je Bulk-Artikel: Restgewicht gesamt, Restwert gesamt, Live Market Value gesamt.
- Je Lot: Lot-Nr. (`BM-0001`), Einkauf (Nr., Datum, Lieferant), Original-Gewicht, Restgewicht,
  **Original Cost/g**, **Current Cost Basis/g**, Restwert, **Live Market/g** und **Live Market Value**
  (Rest × Live/g, mit Hinweis „Referenz, nicht gebucht"), Steuerart, Status.
- Lot-Detail: Purchased composition, „Sold as …" (Definition unten), Bewegungsverlauf (seq, Datum, Art,
  Gewicht, Wert, Beleg, Benutzer, Grund), Verkäufe mit Gewicht, COGS, Erlös netto, Marge, Marge/g.
- Aktionen: Lot korrigieren (nur unbenutzt), Write off X g, Close Lot, Abschreibung stornieren (nur
  ADMIN, nur auf der letzten Bewegung angeboten).
- Platin: Live-Werte „—" (keine Live-Quelle, spot-prices.ts:81).

**„Sold as" — Nettoaggregation aus dem aktuellen Verkaufs- und Retourenzustand** (nicht aus dem
Bewegungsjournal):

```sql
SELECT il.bulk_type, SUM(il.bulk_weight_mg) AS sold_mg
  FROM invoice_lines il
  JOIN invoices i ON i.id = il.invoice_id
 WHERE il.lot_id = :lotId
   AND il.bulk_weight_mg IS NOT NULL
   AND i.status <> 'CANCELLED'
   AND NOT EXISTS (SELECT 1 FROM sales_return_lines srl
                     JOIN sales_returns sr ON sr.id = srl.return_id
                    WHERE srl.invoice_line_id = il.id AND sr.status <> 'REJECTED')
 GROUP BY il.bulk_type
```

- Gelöschte Rechnungen/entfernte Zeilen existieren nicht mehr und zählen damit nicht.
- Stornierte Rechnungen zählen nicht (auch der Weg über eine automatische Retoure, 8.2).
- Eine aktive (nicht abgelehnte) Retoure nimmt die Zeile heraus; eine stornierte Retoure (`REJECTED`) gibt
  sie zurück in die Statistik.
- Maßgeblich ist der **aktuelle** `bulk_type`; eine Typänderung per Rechnungsbearbeitung wirkt rückwirkend.
- Zuordnung zur Composition: RING→RINGS, BRACELET_BANGLE→BRACELETS_BANGLES, NECKLACE_CHAIN→NECKLACES_CHAINS,
  EARRINGS→EARRINGS, PENDANT→PENDANTS, SET→SETS, OTHER→MIXED_OTHER; BY_WEIGHT als eigene Zeile „By weight".
- Anzeige z. B. „Purchased composition: Rings 180.000 g" und daneben „Sold as Rings: 63.000 g" — nie
  „Rings remaining".
- Gegenprobe: Summe aller Typen = Invariante 9.

### 12.2 Precious Metals

Derselbe Hinweis auf `MetalList.tsx` (Seitenebene beim Fehler-Slot :304 und im New-Modal :553-570). Keine
automatische Verbindung, keine Migration zwischen den Modulen.

### 12.3 Ausblenden (Bulk-Systemartikel erscheinen dort nicht)

| Bereich | Stelle | Filter heute | Änderung |
|---|---|---|---|
| Collection-Liste, Excel-Export, Stock Check, Zebra-Etiketten, Kopfzeilen-Summen | WatchList.tsx:277-317, 546, 1207, 1263 | Kategorie `cat-repair-service` (:280) | + `cat-bulk-metal` |
| Inventur-Sitzung (Server) | inventory-house.ts:98-117, src-tauri `stock_check.rs:176-179` | nur Filiale | Bulk-Ids abweisen |
| Rechnungs-Stückauswahl | InvoiceCreate.tsx:186-193 | nur Status | Bulk ausblenden (Bulk nur über „Add bulk metal") |
| Angebot, Auftrag, Auftragszeile | OfferList.tsx:93, OfferDetail.tsx:77, OrderCreate.tsx:177, OrderLineEditModal.tsx:63; Gates offer-house.ts:147, order-house.ts:37 | Status bzw. keiner | ausblenden + Gate |
| Reparatur (eigener Artikel) | repair-rules.ts:125-127 | `svc-repair-` | + `bulk-` |
| Produktion Input | ProductionPage.tsx:76, production-house.ts:195-199 | `in_stock` | ausblenden + Gate |
| Agenten-Übergabe | AgentList.tsx:123, transfer-rules.ts:41, transfer-house.ts:39 | `in_stock` | ausblenden + Gate |
| Einkauf „existing"-Auswahl | PurchaseCreate.tsx:228-238, purchase-house.ts:42 | `cat-repair-service` | + `cat-bulk-metal` (Bulk nur im Bulk-Modus) |
| Fern-Lesen Produkte | read-commands.ts:200-247 (`products.list`), :250-274 (`products.get`) | `cat-repair-service` bzw. nur Filiale | + Bulk |
| Handy Check Item / Suche | src-tauri `product_query.rs:354-388, 424-498`, `routes.rs:1330-1335` (Changelog-Fallback) | nur Mandant/Filiale | `id NOT LIKE 'bulk-%'` |
| Dubletten | productStore.ts:1494-1600, SyncDuplicateGuard.tsx:284-291, SettingsPage.tsx:2388-2419 | keiner | ausschließen |
| Globale Suche | core/search/global-search.ts:140-158 | Filiale | ausschließen |
| Excel-Import | product-import.ts:178, ImportPage.tsx:393 | keiner | aus Index und Kategorieliste ausschließen |
| KI | business-tools.ts:181-189 (Ladenhüter), productStore.ts:508-552 (Korrekturen) | keiner | ausschließen |
| Übersicht | Dashboard.tsx:135 (Featured), :692/:997 (Stückzahlen); CustomerDetail.tsx:186-196; automation-handlers.ts:404 | `in_stock` | ausschließen |
| Analytics Stückzählungen | analytics-snapshot.ts:184-204 | `in_stock` | ausschließen |

### 12.4 Einbeziehen (Wert ja, Stückzahl nein)

Lagerwert-Rechnungen nutzen heute Produkte und Stücklots, nie das INVENTORY-Konto (`computeStockValuation`,
lot-queries.ts:466-482). Neue Funktion `bulkInventoryValuation(ctx)` = Σ `remaining_value_fils` der
Bulk-Lots mit Status `ACTIVE` (plus Gewicht je Metall/Feinheit). Sie wird als eigene Zeile „Bulk metal"
addiert in: `productStore.getStockValue`/`getStockByCategory` (productStore.ts:1415-1441, Übersicht
Dashboard.tsx:132-133), analytics-snapshot.ts:148-168, BusinessReportsPage.tsx:296-316,
business-tools.ts:279 und den Lagerkopf des Handys (read-commands.ts:225-240). Stückzahlen bleiben ohne
Bulk. Collection-Summen und Collection-Excel bleiben reine Stückansichten (ohne Bulk).

---

## 13. PC2, Befehle, Rechte, Audit, Replay

### 13.1 Grundregel

PC2 rechnet nichts Fachliches. Es schickt Absicht; Zuteilung, Restwerte, Steuerart, Snapshot rechnet der
Primary in `runRemoteCommand` (mutation-engine.ts:104-219). Vorschauen (COGS, Current Cost/g) kommen als
Lesebefehl vom Primary. Einzige clientseitige Rechnung: Live Market (Referenz) über dieselbe SSOT-Funktion
`bhdPerGramFine` × `metalPurity`, wie Übersicht und Precious Metals heute.

### 13.2 Bestehende Befehle, erweitert (gleicher Name, neue Zeilenform)

| Befehl | Neue Zeilenform | Vom Client verboten |
|---|---|---|
| `purchases.create` | `{mode:'bulk', metal, fineness, weightMg, lineTotalFils, saleTaxScheme, composition?, note?}` | Lot-Wert, Lot-Nr., MwSt-Betrag |
| `invoices.create` | `{kind:'bulk', bulkLotId, weightMg, bulkType, unitPriceFils, description?}` | `productId`, `quantity`, `taxScheme`, `purchasePrice*`, `bulkCogsFils`, Beträge (Liste invoice-command.ts:69-74 erweitern) |
| `invoices.update` | wie create für neue Zeilen; bestehende Bulk-Zeilen nur `lineId`, Preis, Typ, Beschreibung | wie oben + Lot/Gewicht bestehender Zeilen |
| `returns.create`, `returns.cancel`, `invoices.cancel` | keine Formänderung; Bulk-Regeln prüft der Primary | — |

Alle Gewichte und Beträge sind ganze Zahlen (mg bzw. Fils) > 0; der Client wandelt die Texteingabe exakt
um (4.1), der Primary prüft erneut.

### 13.3 Neue Befehle

| Befehl | Art | Recht |
|---|---|---|
| `bulk_metals.correct_weight` | Mutation `{actionId, lotId, expectedRevision, newWeightMg, composition, reason}` | `isAdmin` (ADMIN, MANAGER) |
| `bulk_metals.write_off` | Mutation `{actionId, lotId, expectedRevision, weightMg, reason, businessDate}` | `isAdmin` |
| `bulk_metals.close_lot` | Mutation `{actionId, lotId, expectedRevision, confirmWeightMg, confirmValueFils, reason, businessDate}` | `isAdmin` |
| `bulk_metals.reverse_adjustment` | Mutation `{actionId, lotId, expectedRevision, movementId, reason}` (WRITE_OFF **oder** CLOSE) | `isOwner` (ADMIN) |
| `page.bulk_metals.get` | Lesen | Filiale des Absenders |
| `bulk_metals.lots_for_sale.get` | Lesen (Lot-Auswahl der Rechnung) | Filiale |
| `bulk_metals.lot_detail.get` | Lesen | Filiale |
| `bulk_metals.allocation_preview.get` | Lesen `{lotId, weightMg}` → `{cogsFils, remainingAfter…}` | Filiale |

Registrierung je Mutation: `ALLOWED_MUTATIONS` (command-registry.ts:87-168), `OPERATION_PERMISSIONS`
(command-permissions.ts:56-239), Rust `REMOTE_OPS` (src-tauri/src/bridge.rs:314), Handler in neuem
`core/bridge/bulk-metal-commands.ts`, Import in bridge-listener.ts. Je Lesebefehl: `STORE_READ_OPS`
(store-read-ops.ts:105-160), `registerCommand(..., {kind:'read'})` mit `contextOf` (Filiale aus dem
geprüften Absender, store-read-commands.ts:53-56), Rust-Konstante. Zähler: 184 → 192 (4 Mutationen, 4
Lesebefehle). Abdeckungstest `test/bridge/c4-read-revocation.test.ts:228` muss grün bleiben.

Domain-Fehler (`BulkRejected`) werden wie `MetalRejected` in `CommandRejected` übersetzt
(metal-commands.ts:293-298) und damit als eingefrorene Antwort gespeichert. `close_lot` prüft zusätzlich,
dass `confirmWeightMg`/`confirmValueFils` dem aktuellen Rest entsprechen (der Benutzer schließt, was er
sieht).

### 13.4 Rechte

- Bulk-Einkauf: bestehendes `purchases.create`. Bulk-Verkauf: `invoices.create`. Retoure, Storno,
  Bearbeitung: bestehende Regeln.
- Neue Schlüssel in `ROLE_PERMISSIONS` (core/auth/role-permissions.ts:21-51): `bulk_metals.view` (Seite;
  ADMIN, MANAGER, ACCOUNTANT), `bulk_metals.adjust` (Lot korrigieren, Write-off, Close; ADMIN, MANAGER).
  Abschreibung stornieren: nur ADMIN.
- COGS und Einstand auf der Rechnungsansicht nur für Rollen, die heute Einkaufspreise sehen.

### 13.5 Audit

`audit_log` hat keine Grund-Spalte (database.ts:709-721). Daher:

- Der Grund steht in `bulk_lot_movements.reason` (Pflicht bei allen manuellen Aktionen; leer →
  `BULK_REASON_REQUIRED`).
- Zusätzlich `logAuditOrThrow` (core/audit/audit-log.ts:109) mit `module:'BulkMetals'`,
  `entityType:'stock_lots'`, `action:'STATUS_CHANGE'` bzw. `'UPDATE'`, `newValue` = JSON mit Art, Gewicht,
  Wert, Grund, Lot-Nr., `action_id`.
- Einkauf, Verkauf, Retoure: bestehende Audits plus die Bewegung (Benutzer, Zeit, Beleg).

### 13.6 Manuelle Aktionen: `action_id` und Replay (verbindlich)

**Erzeugung.** Beim Öffnen eines Dialogs für eine manuelle Aktion erzeugt die Oberfläche (Primary wie PC2)
eine `action_id` (UUID, wie `newCommandId()`, client-command-save.ts:64). Sie bleibt für **jeden** Absende-
Versuch dieses Dialogs gleich — Doppelklick, Wiederholung nach Fehleranzeige, Wiederholung nach verlorener
Antwort — bis eine Erfolgsantwort angezeigt wurde. Ein neuer Dialog erzeugt eine neue `action_id`. Der
Absende-Knopf ist während eines laufenden Versuchs gesperrt (Single-Flight).

**`payload_hash`.** Hash der kanonischen fachlichen Eingabe ohne `expectedRevision`: Aktionsart, `lotId`,
Gewicht(e), Composition, `movementId`, Grund, Geschäftsdatum.

**Reihenfolge in der Hausfunktion (zwingend, in der Transaktion):**

1. Form prüfen (ohne Datenbankzugriff).
2. **Replay-Prüfung zuerst:** Bewegung mit `(branch_id, action_id)` suchen.
   - gefunden, `payload_hash` gleich → das gespeicherte `result_json` **identisch** zurückgeben; keine
     Revisionsprüfung, keine Mutation, keine Buchung;
   - gefunden, `payload_hash` verschieden → `BULK_ACTION_ID_CONFLICT`.
3. Nur wenn keine Bewegung existiert: `expectedRevision` prüfen (`BULK_LOT_REVISION_CHANGED`), Fachregeln
   prüfen, mutieren, Bewegung mit `action_id`, `payload_hash`, `result_json` schreiben, buchen, auditieren,
   Invarianten prüfen.

Damit scheitert eine Wiederholung nach verlorener Antwort nicht an der inzwischen erhöhten Revision,
sondern bekommt dieselbe Antwort. Der Unique-Index `uq_bulk_mov_action` ist nur die letzte Schutzwand; das
Replay-Verhalten implementiert die Hausfunktion explizit.

**Ablehnungen** schreiben keine Bewegung. Lokal wird eine Wiederholung derselben `action_id` neu bewertet
(nichts wurde verändert). Fern friert `remote_command_ledger` die Ablehnung zusätzlich unter der
`command_id` ein (command-ledger.ts:36-50); geänderte Eingaben bekommen dort wie heute eine neue
`command_id`.

**PC2:** Zuerst greift wie heute das Replay über `command_id` (mutation-engine.ts:138). Schickt der Client
dieselbe Absicht mit neuer `command_id` erneut, greift das `action_id`-Replay in der Hausfunktion. Beide
Wege liefern dieselbe Antwort, es entsteht nie eine zweite Bewegung.

**`result_json`** enthält: Bewegungs-Id, `seq`, Art, Gewicht/Wert der Bewegung, Lot-Stand danach
(Gewicht, Wert, Status, Revision), bei Lot-Korrektur Composition vorher/nachher.

---

## 14. Fehlerfälle, Idempotenz, Nebenläufigkeit

### 14.1 Fehlercodes

| Code | Wann |
|---|---|
| `BULK_WEIGHT_INVALID` | Gewicht ≤ 0, falsches Textformat, > 3 Dezimalen, keine sichere ganze Zahl |
| `BULK_AMOUNT_INVALID` | Betrag falsches Textformat, > 3 Dezimalen, keine sichere ganze Zahl |
| `BULK_WEIGHT_EXCEEDS_REMAINING` | Verkauf/Write-off > Restgewicht |
| `BULK_LOT_NOT_FOUND` / `BULK_LOT_NOT_ACTIVE` | falsche Filiale, CANCELLED, Restgewicht 0 |
| `BULK_LOT_REVISION_CHANGED` | `expectedRevision` passt nicht (erst nach Replay-Prüfung) |
| `BULK_ACTION_ID_CONFLICT` | gleiche `action_id`, andere fachliche Eingabe |
| `BULK_TYPE_INVALID` | Typ nicht in der Liste |
| `BULK_METAL_INVALID` | Metall/Feinheit nicht in `METAL_GRADES` |
| `BULK_COMPOSITION_EXCEEDS_WEIGHT` | Composition-Summe > (neues) Gesamtgewicht |
| `BULK_PRODUCT_DIRECT_SALE` | Bulk-Systemartikel als normale Zeile |
| `BULK_SYSTEM_PRODUCT_LOCKED` | normales Bearbeiten/Löschen von Systemartikel oder -kategorie |
| `BULK_LINE_FIELDS_LOCKED` | Lot/Gewicht einer bestehenden Bulk-Zeile geändert |
| `BULK_RETURN_WHOLE_LINE_ONLY` | Rückgabemenge ≠ 1 |
| `BULK_RETURN_DISPOSITION` | Disposition ≠ IN_STOCK |
| `RETURN_STOCK_RESOLD` (bestehend) | Retoure-Storno würde Invariante verletzen |
| `BULK_LOT_IN_USE` | Einkauf stornieren / Lot korrigieren bei benutztem Lot |
| `BULK_REVERSAL_NOT_LAST` | Ziel ist nicht die letzte Bewegung, nicht WRITE_OFF/CLOSE oder schon storniert |
| `BULK_CLOSE_STALE` | `confirmWeightMg`/`confirmValueFils` ≠ aktueller Rest |
| `BULK_REASON_REQUIRED` | Grund fehlt |
| `BULK_NOT_SUPPORTED_HERE` | Angebot, Auftrag, Kommission, Agent, Produktion, Partner, Lieferantenrückgabe |
| `BULK_LOT_PIECE_PATH` | interner Schutz: Stückfunktion auf Bulk-Lot |
| `BULK_INVARIANT_VIOLATED` | interne Prüfung schlägt an → Rollback |

### 14.2 Idempotenz

- **Belege** (Einkauf, Verkauf, Zeile entfernen, Storno, Löschen, Retoure, Retoure-Storno): Unique-Index
  `uq_bulk_mov_source(kind, source_id, source_line_id)` — derselbe Beleg bewegt ein Lot nur einmal.
  Fern zusätzlich `command_id`-Replay; Hauptbuch `hasLedgerEntries`/`hasReversalFor` wie heute.
- **Manuelle Aktionen:** `action_id` mit explizitem Replay (13.6); `uq_bulk_mov_action` als Schutzwand;
  Buchung je `action_id` genau einmal.
- **Stornieren einer Abschreibung:** zusätzlich `uq_bulk_mov_reverses`.

### 14.3 Nebenläufigkeit

Alle Schreibvorgänge laufen auf dem Primary exklusiv (`runExclusive` in runOnPrimary/executeCommand). Zwei
PCs, die gleichzeitig die letzten Gramm verkaufen: der zweite bekommt `BULK_WEIGHT_EXCEEDS_REMAINING`. Zwei
gleichzeitige Einkäufe bekommen nacheinander `BM-0001`, `BM-0002`. Die COGS-Vorschau kann zwischen Vorschau
und Speichern abweichen; gespeichert wird immer der Wert aus der Transaktion, die Rechnung zeigt danach
diesen Wert.

### 14.4 Atomarität

Jede Bulk-Aktion ist eine Transaktion: Lot, Lot-Nummer, Bewegung, Rechnungs-/Retouren-Zeilen, Hauptbuch,
Audit, Invariantenprüfung. Jeder Fehler → vollständiger Rollback.

---

## 15. Durchgerechnetes Beispiel

Silver 925, Einkauf bei einer Privatperson (Einkauf ZERO, Lot-Steuerart MARGIN). Alle Werte BHD mit 3
Dezimalen; intern mg/Fils.

### Schritt 0 — Einkauf 500.000 g für 1,000.000

- Composition: Rings 180 g, Bracelets/Bangles 100 g, Necklaces/Chains 120 g, Sets 70 g, Mixed/Other 30 g
  (Summe 500 g = Gesamtgewicht, zulässig).
- Einkaufszeile: `bulk-silver-925-…`, Menge 1, Betrag 1,000.000, VAT 0, „Silver 925 · 500.000 g (bulk)".
- Lot **BM-0001**: 500,000 mg / 1,000,000 Fils, MARGIN, ACTIVE. Original Cost/g 2.000, Current 2.000.
- Bewegung seq 1 PURCHASE +500,000 mg / +1,000,000 Fils.
- Hauptbuch: Soll INVENTORY 1,000.000 / Haben AP 1,000.000.

### Schritt 1 — Ring 7.000 g, Preis 25.000

- COGS = 1,000,000 × 7,000 / 500,000 = **14,000 Fils = 14.000**.
- Rechnungszeile: „Ring · Silver 925 · 7.000 g", Menge 1, `unit_price` 25.000, MARGIN, interne MwSt
  (25 − 14) × 10/110 = 1.000, `line_total` 25.000, `purchase_price_snapshot` 14.000, `lot_id` BM-0001,
  `bulk_weight_mg` 7,000, `bulk_cogs_fils` 14,000, `bulk_type` RING.
- Hauptbuch (INVOICE): Soll AR 25.000 / Haben REVENUE 24.000 / Haben MARGIN_VAT 1.000; Soll COGS 14.000 /
  Haben INVENTORY 14.000.
- Bewegung seq 2 SALE −7,000 / −14,000. Lot: **493.000 g / 986.000**, ACTIVE, Current Cost/g 2.000.

### Schritt 2 — Necklace 21.500 g, Preis 70.000

- COGS = 986,000 × 21,500 / 493,000 = **43,000 Fils = 43.000**.
- Zeile: „Necklace/Chain · Silver 925 · 21.500 g", `unit_price` 70.000, MARGIN, MwSt (70 − 43) × 10/110 =
  2.454… → 2.455, `line_total` 70.000, snapshot 43.000.
- Hauptbuch: Soll AR 70.000 / Haben REVENUE 67.545 / Haben MARGIN_VAT 2.455; Soll COGS 43.000 / Haben
  INVENTORY 43.000.
- Bewegung seq 3 SALE −21,500 / −43,000. Lot: **471.500 g / 943.000**, ACTIVE.

### Schritt 3 — Teil-Schwund 1.200 g (Grund „Nachwiegen, Waagendifferenz")

- Wert = 943,000 × 1,200 / 471,500 = **2,400 Fils = 2.400**.
- Hauptbuch (STOCK_ADJUST, `source_id` = action_id): Soll INVENTORY_LOSS 2.400 / Haben INVENTORY 2.400.
  Kein COGS, keine MwSt.
- Bewegung seq 4 WRITE_OFF −1,200 / −2,400. Lot: **470.300 g / 940.600**, ACTIVE.
- (Wäre das ein Tippfehler, könnte ADMIN genau diese Bewegung jetzt stornieren — sie ist die letzte. Nach
  Schritt 4 nicht mehr.)

### Schritt 4 — Ring-Verkauf komplett retourniert (bar erstattet, Rechnung war bezahlt)

- Retoure Menge 1, IN_STOCK. Lot zurück exakt +7,000 mg / +14,000 Fils.
- Hauptbuch: Gutschrift Soll REVENUE 24.000 / Soll MARGIN_VAT 1.000 / Haben CASH 25.000;
  SALES_RETURN_COGS Soll INVENTORY 14.000 / Haben COGS 14.000.
- Rechnungszeile unverändert; Anzeige „RETURNED (1/1)" über `sales_return_lines`.
- Bewegung seq 5 RETURN +7,000 / +14,000. Lot: **477.300 g / 954.600**, ACTIVE.

### Schritt 5 — (zusätzlich, damit das Schließen realistisch ist) Händlerverkauf By weight 475.000 g, Preis 1,000.000

- COGS = 954,600 × 475,000 / 477,300 = **950,000 Fils = 950.000**.
- Zeile: „By weight · Silver 925 · 475.000 g", MARGIN, MwSt (1000 − 950) × 10/110 = 4.545, REVENUE 995.455.
- Hauptbuch: Soll AR 1,000.000 / Haben REVENUE 995.455 / Haben MARGIN_VAT 4.545; Soll COGS 950.000 /
  Haben INVENTORY 950.000.
- Bewegung seq 6 SALE. Lot: **2.300 g / 4.600**, ACTIVE.

### Schritt 6 — Close Lot (Grund „Rest Abrieb")

- Abschreibung exakt Rest: 2,300 mg / 4,600 Fils.
- Hauptbuch: Soll INVENTORY_LOSS 4.600 / Haben INVENTORY 4.600.
- Bewegung seq 7 CLOSE −2,300 / −4,600. Lot: **0.000 g / 0.000**, CLOSED.
- (ADMIN könnte diese Schließung stornieren, solange sie die letzte Bewegung ist: seq 8
  ADJUSTMENT_REVERSAL +2,300 / +4,600, Lot wieder ACTIVE mit 2.300 g / 4.600, `closed_at` leer,
  Hauptbuch-Spiegel Soll INVENTORY 4.600 / Haben INVENTORY_LOSS 4.600.)

### Abstimmung

| | Gewicht (g) | Wert |
|---|---|---|
| Einkauf | 500.000 | 1,000.000 |
| Ring verkauft − retourniert | 0.000 | 0.000 |
| Necklace | 21.500 | 43.000 |
| By weight | 475.000 | 950.000 |
| Schwund + Close | 3.500 | 7.000 |
| **Summe** | **500.000** | **1,000.000** |

INVENTORY-Konto über alle Bulk-Buchungen: +1000 − 14 − 43 − 2.4 + 14 − 950 − 4.6 = **0.000** = Restwert.
Sold as: Necklaces/Chains 21.500 g, By weight 475.000 g (Ring retourniert, zählt nicht); Summe 496.500 g =
−(−7 − 21.5 + 7 − 475) aus den Bewegungen (Invariante 9).

### Variante VAT_10 (gleiche Ware, Einkauf mit Vorsteuer, Lot-Steuerart VAT_10)

- Einkauf: Betrag 1,100.000 brutto → `vat_fils` = 100,000, Lot-Wert 1,000,000 Fils (identisch).
  Hauptbuch: Soll INVENTORY 1,000.000 / Soll VAT_INPUT 100.000 / Haben AP 1,100.000.
- Ring 7.000 g, Preis 25.000 (= Netto nach bestehendem Vertrag): COGS 14.000 (identisch); MwSt 2.500
  ausgewiesen; `line_total` 27.500.
  Hauptbuch: Soll AR 27.500 / Haben REVENUE 25.000 / Haben VAT_OUTPUT 2.500; Soll COGS 14.000 / Haben
  INVENTORY 14.000.
- Retoure dieser Zeile: Gutschrift Soll REVENUE 25.000 / Soll VAT_OUTPUT 2.500 / Haben CASH 27.500;
  COGS-Rückbuchung 14.000.

### Rundungsbeispiel (letzter Verbrauch gleicht aus)

Lot 3.000 g für 10.000 BHD (3,000 mg / 10,000 Fils; Original Cost/g 3.333):

| Schritt | Rechnung | COGS | Rest |
|---|---|---|---|
| 1 g | 10,000 × 1,000 / 3,000 = 3,333.33 → | 3.333 | 2.000 g / 6.667 (Current Cost/g 3.334) |
| 1 g | 6,667 × 1,000 / 2,000 = 3,333.5 → half-up | 3.334 | 1.000 g / 3.333 |
| 1 g (ganzer Rest) | w = W → Rest | 3.333 | 0 / 0, EXHAUSTED |

Summe 10.000 — kein Float-Rest, Restgewicht und Restwert erreichen 0 gemeinsam.

---

## 16. Kanonische Entscheidungen (vormals offen)

Die Spezifikation enthält keine offenen V1-Entscheidungen mehr.

| Nr. | Regel |
|---|---|
| K1 | Lot-Nummer `BM-0001` je Filiale, eigener Zähler `bulk_lot_sequences`, Vergabe in der Primary-Transaktion mit Kollisionsprüfung gegen `stock_lots(branch_id, lot_no)`; Unique-Index als letzte Schutzwand (2.4, 2.8). |
| K2 | Abschreibung stornieren gehört zu V1: nur ADMIN, nur die letzte Bewegung des Lots, nur WRITE_OFF oder CLOSE, exakte mg/Fils, exakter Hauptbuch-Spiegel; bei CLOSE wieder ACTIVE und `closed_at = NULL` (Kapitel 10). |
| K3 | Retoure (und Zeile entfernen/Storno/Löschen) in ein CLOSED- oder EXHAUSTED-Lot reaktiviert es (`ACTIVE`, `closed_at = NULL`); die Schließung bleibt im Verlauf (8.1, 9.2). |
| K4 | `sale_tax_scheme` am Lot: MARGIN, VAT_10 oder ZERO; die fachliche Zulässigkeit folgt der bestehenden Steuerregel des Hauses (6.2). |
| K5 | Bulk-Systemartikel ohne SKU (`NULL`), hart gesperrt gegen normales Bearbeiten/Löschen, Kategorie ebenso (3.2). |
| K6 | Rechnungspreis = bestehender Zeilenvertrag des Steuerschemas, keine eigene Netto-Semantik (7.2). |
| K7 | Neue Bulk-Eingaben nur über exaktes Text→mg/Fils-Parsing (4.1). |
| K8 | Manuelle Aktionen mit stabiler `action_id`; Replay vor Revisionsprüfung (13.6). |
| K9 | Composition nur mit der Korrektur eines unbenutzten Lots änderbar; nie `Summe > Gewicht`; nie skaliert (6.5). |
| K10 | „Sold as" aus dem aktuellen Verkaufs-/Retourenzustand, aktueller `bulk_type` (12.1). |

---

## 17. Testmatrix

Gezielte Tests während des Baus, volle Regression einmal am Schluss.

| Nr. | Bereich | Prüfung |
|---|---|---|
| M1 | Rechnen | `allocate` half-up, w = W nimmt Rest, BigInt bei 10^8 × 10^8, Rundungsbeispiel 15 exakt |
| M2 | Parsing | Gramm: „7", „7.5", „7.500" ok; „7.5001", „0", „-1", „1,5", „1e3", „ 7" abgewiesen. BHD: „25", „1000.000" ok; „1,000.000", „25.0001" abgewiesen. Keine Float-Rundung im Pfad (Quelltext-Pin) |
| M3 | Einkaufswert | 4.5: Lot-Wert = INVENTORY-Soll für ZERO und VAT_10, auch an Rundungsgrenzen (z. B. 0.001, 0.011, 999.999 brutto) |
| P1 | Einkauf | Bulk-Zeile ZERO und VAT_10: Systemartikel + Kategorie lazy, `sku` NULL, Lot-Werte, BM-Nummer, Bewegung, INVENTORY = Lot-Wert |
| P2 | Einkauf | gemischter Einkauf (Stück + Bulk), Composition-Grenze, Buchungsfehler → Rollback inkl. Lot-Nummer |
| P3 | Einkauf | Storno unbenutzt → CANCELLED + Spiegelbuchung; benutzt → `BULK_LOT_IN_USE`; Lieferantenrückgabe/Partner gesperrt |
| P4 | Lot korrigieren | Gewicht ± unbenutzt; Gewicht unter Composition-Summe ohne Composition-Änderung → abgewiesen; mit angepasster Composition → ok; keine Skalierung; nur Composition ändern → ok; nach Verkauf → `BULK_LOT_IN_USE` |
| B1 | Lot-Nummern | Primary-Einkauf dann PC2-Einkauf → BM-0001, BM-0002; zwei Bulk-Zeilen → fortlaufend; zwei Filialen → je BM-0001; Zähler zu niedrig/fehlt → Selbstheilung über MAX; vorhandene BM-0003 wird übersprungen; erzwungenes Duplikat scheitert am Unique-Index; zurückgerollter Einkauf verbraucht keine Nummer |
| K1 | Systemartikel | `products.update` fern, `updateProduct`/`deleteProduct`/`deleteProducts`/`updateCategory` lokal → `BULK_SYSTEM_PRODUCT_LOCKED` bzw. blocked; Import kann ihn nicht treffen |
| S1 | Verkauf MARGIN | Beispiel Schritt 1–2: Zeile, Snapshot, MwSt, COGS-Buchung, Bewegung, Lot |
| S2 | Verkauf VAT_10 | Variante VAT_10: Preis netto 25.000 → MwSt 2.500, `line_total` 27.500, COGS 14.000; Zeile identisch zu normaler VAT_10-Zeile mit gleichem Preis/Einstand |
| S3 | Verkauf | Lot falsche Filiale / CANCELLED / Gewicht > Rest / Typ ungültig / Systemartikel als Stückzeile |
| S4 | Verkauf | letzter Verkauf nimmt exakt Rest → EXHAUSTED |
| S5 | Verkauf | Stückpfade sehen Bulk-Lot nie: FIFO, `consumeLot`/`restoreLot` werfen, Aggregates 0, `reconcileSaleStatus` unberührt |
| E1 | Edit | Preis/Typ/Beschreibung ändern ok, Lot/Gewicht → gesperrt, COGS unverändert neu gebucht |
| E2 | Edit | Zeile entfernen → exakt zurück; entfernen + neu im selben Edit aus erschöpftem Lot |
| C1 | Storno | ohne Zahlung, mit Zahlung (Retourenweg, kein doppeltes Zurück), Löschen |
| R1 | Retoure | Schritt 4: exakt zurück, COGS-Rückbuchung = `bulk_cogs_fils`, EXHAUSTED/CLOSED → ACTIVE |
| R2 | Retoure | Menge 0.5 / Disposition WRITE_OFF → abgewiesen; gemischte Retoure Stück + Bulk; VAT_10-Retoure |
| R3 | Retoure | Retoure-Storno ok; nach Weiterverkauf → `RETURN_STOCK_RESOLD`; Fall W' = 0 mit V' ≠ 0 → abgewiesen |
| W1 | Write-off | Schritt 3 und 6, Grund Pflicht, Revision, X = W → Close, Wert 0 → keine Buchung, `close_lot` mit veraltetem Rest → `BULK_CLOSE_STALE` |
| W2 | Stornieren | letzte WRITE_OFF → exakt zurück + Spiegel; letzte CLOSE → ACTIVE, `closed_at` NULL + Spiegel; nicht letzte → `BULK_REVERSAL_NOT_LAST`; zweimal stornieren / Stornierung stornieren → abgewiesen; MANAGER → `PERMISSION_DENIED` |
| A1 | Replay lokal | Doppelklick (zwei Aufrufe, gleiche `action_id`) → eine Bewegung, identische Antwort |
| A2 | Replay lokal | verlorene Antwort: erster Aufruf committet, Wiederholung mit gleicher `action_id` und alter `expectedRevision` → gespeichertes Ergebnis identisch, **kein** `BULK_LOT_REVISION_CHANGED` |
| A3 | Replay | gleiche `action_id`, andere Eingabe → `BULK_ACTION_ID_CONFLICT`; Ablehnung ohne Bewegung → Wiederholung wird neu bewertet |
| A4 | Replay PC2 | gleiche `command_id` → eingefrorene Antwort; neue `command_id` + gleiche `action_id` → identische Antwort, eine Bewegung; gilt für alle 4 manuellen Befehle |
| SA1 | Sold as | nach Verkauf, Retoure, Retoure-Storno, Rechnungs-Storno (mit/ohne Zahlung), Löschen, Typänderung; Summe = Invariante 9 |
| L1 | Invarianten | nach **jedem** Schritt des Beispiels und der Varianten alle Regeln aus Kapitel 5; Abstimmungstabelle 15 |
| L2 | Hauptbuch | `INVENTORY_LOSS` in `NATURAL_DEBIT`, Saldo positiv; Gewinnzeile in Auswertungen inkl. Stornierung |
| N1 | NBR MARGIN | Bulk-MARGIN-Zeile im NBR-Export: Steuerbasis = `line_total − purchase_price_snapshot × 1` (nbr-export.ts:380), Beschreibung mit Gewicht, kein Lot/COGS/SKU in den Spalten |
| N2 | NBR VAT_10 | Bulk-VAT_10-Zeile: Netto 25.000, MwSt 2.500 wie normale Zeile; kein Lot/COGS/SKU |
| H1 | Ausblenden | jede Zeile aus 12.3 (UI-Filter, Server-Gate, Fern-Lesen) |
| H2 | Einbeziehen | Übersicht/Analytics/Reports: Wert enthält Bulk, Stückzahl nicht |
| X1 | PC2-Parität | Einkauf, Verkauf, Edit, Retoure, Retoure-Storno, Lot korrigieren, Write-off, Close, Stornieren über Fernbefehl = identische DB wie lokal (Muster r6d) |
| X2 | PC2 | verbotene Felder (COGS, Steuerart, Menge, Lot-Wert) abgewiesen; Gewicht/Betrag keine ganze Zahl → abgewiesen |
| X3 | PC2 | Rechte: SALES darf verkaufen, nicht abschreiben; nur ADMIN storniert; Revision veraltet → abgewiesen |
| X4 | PC2 | Registry 192 TS = Rust, Abdeckungstest grün |
| D1 | Druck | A5/Browser-Beleg/Gutschrift ohne Lot, COGS, SKU; Beschreibung mit Gewicht |
| D2 | Migration | zweimaliger Start ohne Fehler; Manifest-Drift-Test grün; tsc (`tsconfig.app.json`) 0 |
| Z1 | Zwei-App-E2E | Primary + PC2 (eigene Ports, nie 3001/3443): Bulk-Einkauf auf PC2 (BM-0001), Einkauf auf Primary (BM-0002), Verkauf auf PC2, Retoure auf Primary, Close auf PC2, Seite auf beiden gleich |
| Z2 | Handy | Check Item/Suche finden keinen Bulk-Systemartikel |

---

## 18. Nicht in V1

- Handy (Bulk-Einkauf, -Verkauf, -Ansicht).
- Angebot, Auftrag, Kommission, Agenten-Übergabe, Reparatur, Partnerbeteiligung mit Bulk.
- Produktion: Bulk als Materialverbrauch.
- Rückgabe an den Lieferanten für Bulk-Lots.
- Teil-Retoure einer Bulk-Zeile; Dispositionen außer IN_STOCK.
- Automatische Lot-Wahl (FIFO) für Bulk; Verkauf aus mehreren Lots in einer Zeile.
- Composition als echter Bestand, als Sperre oder als nachträglich änderbare Angabe eines benutzten Lots.
- Gewichtserhöhung nach Benutzung; „gefundene Gramm" als Gewinn.
- Stornieren einer Abschreibung, die nicht mehr die letzte Bewegung ist.
- Automatische MwSt-Korrektur bei Schwund.
- Hauspreis/g für Bulk, Händlerkurs, „Live übernehmen", Neubewertung zum Marktpreis.
- Verbindung oder Migration zwischen Precious Metals / Scrap Gold und Bulk Metals.
- Umrechnung normaler Artikel in Bulk oder umgekehrt (z. B. Ring aus Bulk als Einzelartikel ins Lager).
- Platin-Live-Preis.
- Einkaufsbearbeitung (gibt es generell nicht).
