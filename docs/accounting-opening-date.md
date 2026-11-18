# Buchungsstichtag je Datenbank (Settings → Accounting)

Stand 18.11.2026, lokal, nicht released.

## Was gilt

- Jede LATAIF-Datenbank hat ihren eigenen Buchungsstichtag.
  - Gespeichert in `settings`, Schlüssel `accounting.opening_date`.
  - `settings` gehört nicht zum Sync-Vertrag, kein anderer Rechner übernimmt den Wert.
  - Ohne Eintrag gilt wie bisher **2026-10-15**. Bestehende Installationen verhalten sich unverändert.
- Gelesen wird überall über `accountingOpeningDate()` (`src/core/accounting/opening-date.ts`). Diese Sperrpfade nutzen den Wert:
  - Rechnungskorrekturen;
  - Einkauf bearbeiten und Zahlungsdatum;
  - Zahlungsdialoge für Ausgaben und Lieferanten;
  - Verrechnungen und Settle Balance;
  - Eröffnungssalden und Konten-Eröffnung;
  - Reparatur-Kostendatum.
- Eingereichte oder bezahlte VAT-Quartale bleiben unabhängig davon gesperrt.

## Ändern

- Nur **ADMIN** darf ändern. „owner" ist der alte Name derselben Rolle (`canonicalRole`).
  - Die Rolle wird in der Hausfunktion zweimal geprüft: aus der Anmeldung **und** aus `user_branches` dieser Datenbank.
  - MANAGER, SALES und ACCOUNTANT werden abgelehnt (`PERMISSION_DENIED`).
- Nur am Primary. PC2 erhält die Antwort `PRIMARY_ONLY`.
- Bedienung: neues Datum wählen, „Check“, dann „Save“. Jede Änderung wird auditiert: Benutzer, Zeit, alter und neuer Wert.
- Abgelehnt wird (`OPENING_DATE_UNSAFE`) mit Klartext, was zu tun ist:
  - Gültige Eröffnungsposten auf einem anderen Tag. Sie beschreiben den Saldo an *ihrem* Tag, also erst stornieren:
    - Partei-Eröffnungssalden: Kunden-/Lieferantenseite → Edit → Opening balances;
    - Konten-Eröffnung: Settings → Opening Balances.
  - Ein späterer Tag, wenn zwischen altem und neuem Tag schon Buchungen, Rechnungen oder Einkäufe liegen. Er würde sie rückwirkend sperren.
  - Ein Tag in der Zukunft, vor 2000-01-01 oder ein Tag, den es nicht gibt.
- Eine Änderung fasst nie Rechnungen, Zahlungen, Buchungen oder Eröffnungsposten an.

## PC2 – Kompatibilität

- **Neuer PC2 mit neuem Primary:** PC2 übernimmt den Stichtag des Primary aus `session.context.get`.
- **Neuer PC2 mit altem Primary:** Es gilt 2026-10-15, also derselbe Wert wie am Primary.
- **Alter PC2 mit neuem Primary:** Alle Sperren prüft der Primary mit seinem eigenen Stichtag. Das gilt für:
  - Rechnung bearbeiten und stornieren;
  - Einkauf bearbeiten, dessen Sperrprüfung als Fernlesung vom Primary kommt;
  - Verrechnungen.

### Funktionale Einschränkung: PC2 vor dem neuen Release (z. B. v0.8.101)

Ein PC2 auf einer älteren Version kennt nur den festen 15.10.2026. Ist am Primary ein **früherer** Stichtag eingestellt
(z. B. 01.01.2026), verhindert die alte PC2-Oberfläche einige Buchungen mit Datum vor dem 15.10. schon selbst. Diese Anfragen erreichen den Primary gar nicht.

| PC2-Version | Wo | Wirkung |
|---|---|---|
| v0.8.101 | Rechnung → **Settle Balance** (Verrechnung mit Darlehen) | Verrechnungsdatum vor dem 15.10. wird mit „The offset date must be on or after 15.10.2026 …“ abgelehnt, Speichern nicht möglich |
| v0.8.102–v0.8.108 | zusätzlich **Pay Expense** und **Pay Supplier** | Zahlungsdatum vor dem 15.10. wird mit „… cannot be before the opening cut-off (2026-10-15)“ abgelehnt |
| alle älteren | Eröffnungsposten, Konten-Eröffnung, Hinweistexte | zeigen 15.10. an; erfassen geht auf PC2 ohnehin nicht (`PRIMARY_ONLY`) |

Das ist eine **funktionale Einschränkung, nicht nur ein Anzeigeproblem**. Solche Vorgänge vor dem 15.10. müssen am Primary
gebucht werden, bis PC2 auf dem Release mit dieser Funktion ist. Rechnung und Einkauf bearbeiten sind nicht betroffen, weil
dort die Prüfung am Primary läuft. Umgekehrt (Stichtag am Primary **später** als 15.10.) lässt der alte PC2 zwar Daten zu,
der Primary lehnt sie aber ab. Es entsteht also keine falsche Buchung.

## Nachweise

- `test/opening-date/opening-date.test.ts`: 34/0. Abgedeckt sind Standard, Speichern und Neustart, getrennte Datenbanken, Sperren vor und nach dem Stichtag, VAT, Berechtigung (ADMIN, zweiter ADMIN, MANAGER, ACCOUNTANT, gefälschte Rolle), PC2 und Konflikte.
- `test/e2e/opening-date-ui.e2e.mjs`: 34/0 am 18.11.2026. UI-Smoke-Test in der isolierten E2E-App, Speichern per echtem Mausklick. Er prüft die August-Rechnung und den August-Einkauf vor und nach der Änderung, den Konflikt mit Eröffnungsposten, den späteren Tag, den Neustart und die VAT-Sperre. Die Produktion bleibt dabei unberührt.
