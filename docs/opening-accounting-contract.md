# B1 Opening Accounting — Vertrag (Eröffnungsbilanz: Erfassung und Abstimmung, keine Buchung)

Stand: B1 lokal umgesetzt (15.10.2026). Grundlage: `docs/opening-accounting-completion-plan.md`.
Tests: `test/opening-accounting/b1-foundation.test.ts`.

## Zweck

Der Owner erfasst alle Anfangssalden zum Stichtag **15.10.2026** selbst und gleicht sie mit dem Hauptbuch ab.
B1 **bucht nichts**: keine neue Eröffnungsbuchung, keine Änderung einer bestehenden Buchung, kein Hauptbuch, keine
Kasse/Bank/Benefit, keine VAT, keine Rechnung, kein NBR-Export. Jede Anzeige ist **PROVISIONAL**.

## Bausteine

| Baustein | Datei | Schreibt |
|---|---|---|
| Kontenklassen (Aktiva/Passiva/Eigenkapital/Ertrag/Aufwand, Gruppen, Gegenkonten TAX_PAID/REFUNDS) | `src/core/ledger/account-classes.ts` | nein |
| Saldenliste, vorläufige Bilanz, Stichtagsliste | `src/core/accounting/ledger-statements.ts` | nein |
| Entwurfsbelege + Eröffnungsübersicht + Settings-Altstand | `src/core/accounting/opening-accounting.ts` | nur `opening_account_items` |
| Fernbefehle PC2 | `src/core/bridge/opening-accounting-commands.ts` | über die Hausfolge |
| Oberfläche | `src/components/finance/OpeningAccountingPanel.tsx` (Settings → „Opening Balances“) | über `useSharedWrites` |

## Stichtag

`occurred_at < 00:00 Uhr Ortszeit des 15.10.2026` (`cutoffBoundaryIso`) — dieselbe Kalenderlogik wie der NBR-Export
(`new Date(iso)`, Ortszeit). Die Saldenliste/Bilanzvorschau lässt sich zu einem anderen Datum zeigen; die
Eröffnungsübersicht bleibt immer am Stichtag (Hinweis, wenn abweichend).

## Entwurfsbelege `opening_account_items` (OB-Nummernkreis wie die Parteiposten)

| Art | Seite | Gegenpartei | Regel |
|---|---|---|---|
| CASH_BALANCE / BANK_BALANCE / BENEFIT_BALANCE | Aktiva | keine | **gezählter Stand** am Stichtag (Soll-Stand, kein Zugang); je Konto höchstens einer; ≥ 0, nur Bank darf negativ (überzogen) sein |
| LOAN_RECEIVABLE / LOAN_PAYABLE | A / P | Pflicht (Kunde, Lieferant oder Name) | > 0; Referenz darf keine LATAIF-Darlehensnummer sein; Bestätigung „nicht schon in LATAIF“ |
| OTHER_ASSET / OTHER_LIABILITY | A / P | optional | > 0 |
| VAT_PAYABLE / VAT_RECEIVABLE | P / A | keine | > 0; nur notiert (E3) |

Pflicht: Betrag in Fils (≤ 3 Dezimalen), Referenz (≤ 80), Grund (≤ 500). Doppelte Referenz derselben Art und eine zweite
Zählung sind abgewiesen (auch per Teilindex). `accounting` steht immer auf PENDING — es gibt in B1 keinen Weg zu POSTED.

- **Korrektur** (`correctsId` + `expectedCorrectsRevision`): der alte Beleg wird in derselben Transaktion storniert
  („corrected by OB-…“) und der neue mit `corrects_id` verknüpft — nur gegen den gesehenen Stand (sonst `ITEM_CHANGED`).
- **Storno** (`itemId`, `reason`, `expectedRevision`): Status, Grund, Akteur, Zeit; gelöscht wird nie.
- **Wiederholung**: Aktionskennung + Payload-Hash → derselbe Beleg; andere Absicht unter derselben Kennung →
  `ACTION_ID_CONFLICT`.
- **Atomar**: Nummer, Beleg(e), Protokoll und Sync in einer Transaktion; Fehler → nichts geschrieben.
- **Sync**: `opening_account_items` im Manifest (insert/update, nie delete); Rust-Matrix 57/40/38.
- **Löschsperre**: ein Kunde/Lieferant, der als Gegenpartei genannt ist, wird nicht gelöscht.

## Settings-Eröffnung (Cash/Bank/Benefit, 01.01.2000) — eingefroren

- Vorhandene Werte und die vorhandene Buchung (Quelle `OPENING_BALANCE`, 01.01.2000) bleiben **unverändert**; sie sind
  Teil des Hauptbuchsaldos vor dem Stichtag und zählen damit genau einmal.
- `postOpeningBalances` bucht/storniert nichts mehr: gleich → nichts zu tun; abweichend oder ungültig/negativ →
  `LEGACY_OPENING_FROZEN` (ohne Teilschritt). Backfill meldet das als „skipped“.
- Settings → Tax/VAT zeigt die alten Werte nur noch an; `setSetting` weist `finance.opening_*` ab.
- Ein Settings-Wert, der nie gebucht wurde, zählt **nirgends** (Hinweis in der Übersicht) — der Stand wird als
  gezählter Kassenstand erfasst.

## Eröffnungsübersicht (`page.opening_accounting.get`)

Je Saldoart: **gebucht vor dem Stichtag** (Hauptbuch, Seite der Klasse) und **erfasst, nicht gebucht** getrennt;
Kasse/Bank/Benefit mit Zählung und Differenz (RECONCILED nur bei 0); Kunden-/Lieferantenposten aus Customer/Supplier
Edit; Altbestand aus der Vorschau `/old-stock` als Spanne V2 … V1 (D4/D5 offen). Jede Bilanzposition steht in genau
einer Zeile (Summen = Bilanzvorschau).

Eigenkapital getrennt: gebuchte Eröffnung (OPENING_BALANCE_EQUITY), Partnerkapital, **gebuchtes Ergebnis vor dem
Stichtag** (Ertrag − Aufwand) und das **rechnerische Eröffnungskapital** = gebuchte Eröffnung + Wirkung der Entwürfe.
Nichts wird für nicht erfasste Posten angenommen.

**Altbestand (B1 Final Gate):** die Vorschau kennt nur den **heutigen** Wert (V2 … V1). Er steht als `CURRENT` /
Status `NOT_VERIFIED` da, der Wert zum 15.10.2026 ist `PENDING_NOT_VERIFIED` — er fließt in **keine** Stichtagssumme und
**nicht** ins rechnerische Eröffnungskapital (`provisionalOpening.oldStock.included = false`). Die Bewertung zum
Stichtag löst B5.

**Card Clearing:** es gibt keinen erfassten Abrechnungsstand zum Stichtag → immer `NOT_VERIFIED` und offener
Abstimmungspunkt.

Hinweise (immer PROVISIONAL): fehlende Zählungen, Differenzen, ungebuchte Posten, Settings-Abweichungen,
Altbestand-Prüffälle, unausgeglichenes Hauptbuch, Konten ohne Klasse, unerklärte Bilanzdifferenz.

## Saldenliste, Bilanzvorschau, Stichtagsliste

- Saldenliste: je Konto Soll, Haben, Saldo (Fils-genau), Klasse; Summen und Ungleichgewicht; Konten ohne Klasse werden
  gezeigt, nie still zugeordnet.
- Bilanzvorschau: Aktiva/Passiva nach Gruppen, Eigenkapital (Eröffnung, Partner, Ergebnis), Differenz.
- Stichtagsliste: jede Buchung vor dem Stichtag mit Datum, Belegnummer (soweit auflösbar), Herkunft, Status
  (ACTIVE / REVERSED / REVERSED_AFTER_CUTOFF / REVERSAL), Soll/Haben, Betrag und Wirkung je Gruppe — damit der Owner
  selbst prüft, ob es echte Vorgänge sind. Keine Rückrechnung, keine Ausgleichsbuchung.

## Primary / PC2

`opening_accounts.create` / `.cancel`: Owner (`owner(...)`), Hausfolge prüft den Owner erneut, Ausführung nur am Primary
(Befehlsbuch: Replay, eingefrorene Ablehnung), strenger Rumpf (unbekannte Felder abgewiesen). Registry 123 Buchungen,
83 Auskünfte, Rust `REMOTE_OPS` 207.

**Lesen nur der Owner (B1 Final Gate):** `page.opening_accounting.get` und die Eröffnungsliste `page.opening_balances.get`
prüft der Primary selbst (`mayReadOpeningAccounting`): jede andere Rolle → `PERMISSION_DENIED`, keine Daten. Die Rolle
kommt aus dem geprüften Token (Rust legt `actor` in die Anfrage, der Client nur `input`). Am Primary rechnet die Maske
nur für den Owner.

## Gesperrt (B2–B5)

Eröffnungsbuchung und Festschreibung (E1–E4), Zahlungen auf Eröffnungsposten (E5), Anzahlungsverrechnung (A1, A2),
Erlass/Nachlass/Forderungsausbuchung (W1–W3), Altbestands-Eröffnung (D1–D6, D8). Der VAT-Periodenschutz und der
NBR-Export sind unverändert.
