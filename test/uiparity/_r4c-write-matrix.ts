// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4C — die vierzig Buchungen, Zeile für Zeile.
//
// Diese Datei ist die eine Quelle für „welche Fernbuchung entspricht welcher Handlung in der
// gemeinsamen Oberfläche". Sie ist bewusst DATEN, nicht Prosa: das Gate
// (`r4c-write-matrix.test.ts`) prüft jede Zeile gegen den echten Quelltext, damit die Tabelle
// nicht auseinanderläuft, sobald jemand eine Schaltfläche verschiebt.
//
// `paritaet`:
//   'exakt'    — die Handlung der Oberfläche IST die Fernbuchung: ein Aufruf, dieselbe Funktion,
//                dieselben Argumente. Nur solche werden verdrahtet.
//   'enger'    — die Fernbuchung kann WENIGER als die Handlung (Klasse B). Nicht verdrahten:
//                die halbe Handlung wäre schlimmer als keine.
//   'keine-ui' — die Buchung existiert, aber die gemeinsame Oberfläche bietet die Handlung nicht
//                an. Nichts zu verdrahten; kein Gap in der Oberfläche.
//
// `luecke`: 'A' = es fehlt eine Fernbuchung · 'B' = vorhandene ist enger · 'C' = Maschine/System.
// ════════════════════════════════════════════════════════════════════════════

export interface MatrixZeile {
  /** Der Name der Fernbuchung — muss in `ALLOWED_MUTATIONS` stehen. */
  op: string;
  /** Die Handlung, wie ein Mensch sie kennt. */
  handlung: string;
  /** Wo sie in der gemeinsamen Oberfläche sitzt (Datei unter `src/`). */
  ort: string;
  /** Die lokale Funktion, die der Primary ruft — und die auch der Fernbefehl ruft. */
  lokal: string;
  paritaet: 'exakt' | 'enger' | 'keine-ui';
  /** Ist die Handlung über `useSharedWrite` an die Fernbuchung angeschlossen? */
  verdrahtet: boolean;
  luecke: 'A' | 'B' | 'C' | null;
  grund: string;
}

export const R4C_MATRIX: readonly MatrixZeile[] = [
  // ── Stammdaten ───────────────────────────────────────────────────────────
  {
    op: 'customers.create', handlung: 'Neuen Kunden anlegen', ort: 'pages/customers/CustomerList.tsx',
    lokal: 'createCustomer', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R4B — ein Aufruf, dieselbe Funktion.',
  },
  {
    op: 'customers.update', handlung: 'Kunden aendern', ort: 'pages/customers/CustomerDetail.tsx',
    lokal: 'updateCustomer', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R4B — nur der Unterschied faehrt mit.',
  },
  {
    op: 'products.create', handlung: 'Neuen Artikel anlegen', ort: 'pages/watches/WatchList.tsx',
    lokal: 'createProductWithMedia', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5B — dieselbe Vorbereitung auf beiden Seiten (core/products/product-create: Pflichtfelder nach der Regel des Hauses, veraltete Attribute gestrichen, eine eingetippte SKU getrimmt und gegen den Bestand geprueft, sonst aus dem durablen Zaehler), derselbe Anlageweg mit Medienspeicher. Die Bilder legt der Client ueber die vorhandene Zwischenablage ab; der Auftrag nennt nur ihre Inhaltskennungen. Bestandsstatus und Herkunft bestimmt der Primary.',
  },
  {
    op: 'products.update', handlung: 'Artikel aendern (Text)', ort: 'pages/watches/ProductDetail.tsx',
    lokal: 'editProductTextDurably', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R4B — der Textweg. Der Bildweg ist am Client sichtbar gesperrt (Klasse B).',
  },

  // ── Rechnungen ───────────────────────────────────────────────────────────
  {
    op: 'invoices.create', handlung: 'Direktverkauf anlegen', ort: 'pages/invoices/InvoiceCreate.tsx',
    lokal: 'createDirectInvoice', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R4B — ohne Zahlung beim Anlegen; die ist am Client sichtbar gesperrt (Klasse B).',
  },
  {
    op: 'invoices.update', handlung: 'Rechnungszeilen aendern', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'editInvoice', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf mit Zeilen und Pflichtgrund; Umkehr, Neubuchung, Status und Audit stecken '
      + 'in derselben Transaktion des Hauses.',
  },
  {
    op: 'invoices.record_payment', handlung: 'Zahlung erfassen', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'recordPayment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf, dieselben Argumente (Betrag, Weg, Kartenart).',
  },
  {
    op: 'invoices.apply_credit', handlung: 'Guthaben verrechnen', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'applyCreditToInvoice', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; das Haus entscheidet, wie viel wirklich angerechnet wird.',
  },
  {
    op: 'invoices.update_payment', handlung: 'Zahlung berichtigen', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'updatePayment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf je geaendertem Feld — Betrag, Weg, Datum, Notiz.',
  },
  {
    op: 'invoices.delete_payment', handlung: 'Zahlung loeschen', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'deletePayment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; die Umkehr im Hauptbuch macht das Haus.',
  },

  // ── Retouren ─────────────────────────────────────────────────────────────
  {
    op: 'returns.create', handlung: 'Verkaufsretoure anlegen', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'createReturn', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske schickt zusaetzlich `staffId` (die Fernbuchung kennt das Feld nicht) UND fuehrt bei „sofort erstatten\' — bei Guthaben-Retouren ZWANGSLAEUFIG — direkt `refundReturn` mit aus. Eine Handlung, zwei Buchungen ohne gemeinsame Klammer.',
  },
  {
    op: 'returns.approve', handlung: 'Retoure freigeben', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'approveReturn', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die gemeinsame Oberflaeche ruft `approveReturn` ausschliesslich INNERHALB des Storno-Vorgangs einer Rechnung (anlegen + freigeben + erstatten + Status + Bestandsfreigabe in EINER Absicht). Es gibt keinen eigenstaendigen Knopf dafuer — die Buchung allein waere ein Fuenftel der Handlung.',
  },
  {
    op: 'returns.refund', handlung: 'Retoure erstatten', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'refundReturn', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Ebenso: `refundReturn` steht nur im Storno-Vorgang und im Anlegen-mit-Sofort-Erstattung. Kein eigenstaendiger Vorsatz, den man einzeln verdrahten koennte.',
  },
  {
    op: 'returns.record_refund_payment', handlung: 'Erstattung auszahlen', ort: 'pages/invoices/InvoiceDetail.tsx',
    lokal: 'recordRefundPayment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf mit Betrag, Weg und Gebuehrenabzug — fassungsbasiert.',
  },

  // ── Einkauf ──────────────────────────────────────────────────────────────
  {
    op: 'purchases.create', handlung: 'Einkauf anlegen', ort: 'pages/purchases/PurchaseCreate.tsx',
    lokal: 'createPurchaseOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5E — EINE Vorbereitung fuer beide Seiten (core/purchases/purchase-create, Anschluss purchase-house): neue Artikel ueber die Maske „New Item" (Pflichtfelder und SKU-Riegel der Maske, Fotos ueber die Zwischenablage), `staffId` (aktiver Mitarbeiter der Filiale), `sourceOrderId` mit Positionen GENAU dieses Auftrags (danach „Arrived"), das Inbox-Foto („erledigt") — Belegnummer, Lose, Menge, Status, Vorsteuer, Verbindlichkeit und Buchung rechnet createPurchase. Am Primary in EINER Klammer.',
  },

  // ── Kommission ───────────────────────────────────────────────────────────
  {
    op: 'consignments.create', handlung: 'Kommission anlegen', ort: 'pages/consignments/ConsignmentList.tsx',
    lokal: 'createConsignmentOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5B — EIN Vorgang fuer beide Seiten (core/consignment/consignment-create): Artikel ueber denselben Anlageweg mit Medienspeicher (vorher als Text in products.images), dann die Kommission, in EINER Transaktion (vorher zwei getrennte Schreibvorgaenge ohne Klammer). Der Fernbefehl nimmt jetzt, was die Maske erfasst: SKU, Attribute, Steuer, Lagerort, Lieferumfang, Mitarbeiter, Bildkennungen.',
  },
  {
    op: 'consignments.update', handlung: 'Kommission aendern', ort: 'pages/consignments/ConsignmentDetail.tsx',
    lokal: 'updateConsignment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'EIN Auftrag statt zweier Aufrufe: die Fernbuchung fuehrt Auszahlungsmodell und Stammdaten in derselben Klammer aus, in derselben Reihenfolge wie die Maske.',
  },
  {
    op: 'consignments.record_sale', handlung: 'Kommissionsverkauf erfassen', ort: 'pages/consignments/ConsignmentDetail.tsx',
    lokal: 'recordSale', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske entscheidet mit `specialMark` ueber den Belegnummernkreis der entstehenden Rechnung; die Fernbuchung kennt das Feld nicht und nimmt stillschweigend den normalen Kreis.',
  },
  {
    op: 'consignments.mark_returned', handlung: 'Kommission zurueckgeben', ort: 'pages/consignments/ConsignmentDetail.tsx',
    lokal: 'markReturned', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; der Bestand folgt im Haus.',
  },
  {
    op: 'consignments.record_payout', handlung: 'Auszahlung an den Eigentuemer', ort: 'pages/consignments/ConsignmentDetail.tsx',
    lokal: 'markPaidOut', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske zahlt VOLLSTAENDIG aus (markPaidOut, ohne Betrag); die Fernbuchung kennt nur '
      + 'die TEILAUSZAHLUNG mit Betrag (recordPartialPayout). Zwei verschiedene Handlungen.',
  },

  // ── Auftraege ────────────────────────────────────────────────────────────
  {
    op: 'orders.create', handlung: 'Auftrag anlegen', ort: 'pages/orders/OrderCreate.tsx',
    lokal: 'createOrderOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5E — EINE Vorbereitung fuer jede Auftragsart (core/orders/order-create, Anschluss order-house): die Maske schickt Eingaben, das Haus leitet Produkt-, Angebots- und Kostenzeilen, Summe, Steuer, Kopf und Kundenmaterial ab und legt die GOLD-VERBINDLICHKEIT beim Goldschmied (Gramm, Karat, an der Extra-Gold-Zeile) in DERSELBEN Transaktion an. Neue Artikel und die Final-Product-Spec mit Fotos ueber die Zwischenablage.',
  },
  {
    op: 'orders.update', handlung: 'Auftrag aendern', ort: 'pages/orders/OrderDetail.tsx',
    lokal: 'updateOrderOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5E — „Save" schickt die sechs Eingaben (Preis, Anzahlung, Lieferant, Einkauf, Liefertermin, Notiz; geleert = null); `expectedMargin` und `remainingAmount` leitet das Haus ab (core/orders/order-edit), beim Sonderauftrag zieht es den Preis der ANGEBOTSZEILE statt des Kopfpreises. Am Primary wie fern in EINER Klammer.',
  },
  {
    op: 'orders.update_status', handlung: 'Auftragsstatus setzen', ort: 'pages/orders/OrderDetail.tsx',
    lokal: 'updateStatus', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; der Bestand folgt im Haus.',
  },
  {
    op: 'orders.add_payment', handlung: 'Anzahlung erfassen', ort: 'pages/orders/OrderDetail.tsx',
    lokal: 'addPayment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5A — die Fernbuchung nimmt jetzt die Kartenart entgegen; gerechnet wird die Gebuehr weiterhin ausschliesslich im Haus (bookCardFee in addPayment). Ein Aufruf, dieselben Werte.',
  },
  {
    op: 'orders.delete_payment', handlung: 'Anzahlung loeschen', ort: 'pages/orders/OrderDetail.tsx',
    lokal: 'deletePayment', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf — fassungsbasiert.',
  },
  {
    op: 'orders.convert_to_invoice', handlung: 'Auftrag in Rechnung wandeln', ort: 'pages/orders/OrderDetail.tsx',
    lokal: 'convertOrderLinesToInvoiceTx', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5A — die Fernbuchung fuehrt jetzt den Anzahlungsuebertrag MIT aus, in derselben Transaktion und ueber DIESELBE Funktion wie die Auftragsansicht (core/orders/order-payment-carryover). Eine Handlung, eine Buchung, kein liegengebliebenes Geld. R5A.2 — die Rechnungszeilen rechnet DIESELBE Funktion wie die Ansicht (core/orders/order-invoice-lines; vorher Steuer immer obendrauf, bei MARGIN +10 %), und die Wahl der beiden Dialoge (Schema je Zeile, Nummernart, abschliessen) reist als gepruefte Felder mit. Positionen ohne Artikel und Auftraege ohne Schema lehnt der Client ausdruecklich ab.',
  },

  // ── Reparaturen ──────────────────────────────────────────────────────────
  {
    op: 'repairs.create', handlung: 'Reparatur anlegen', ort: 'pages/repairs/RepairList.tsx',
    lokal: 'createRepairOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5C — EINE Vorbereitung fuer beide Seiten (core/repairs/repair-rules: planRepairCreate), Kunden- UND Eigenreparatur. Bei eigener Ware nennt der Auftrag nur Artikel und Los; Platzhalter-Kunde, `in_repair`, die Angaben des Artikels und die Nummern setzt der Primary. Dazu Kategorie mit ihren Pflichtfeldern, Merkmale, Referenz, Beschreibung, Mitarbeiter und Fotos (ueber die vorhandene Zwischenablage). Am Primary in EINER Klammer (repair-house).',
  },
  {
    op: 'repairs.update', handlung: 'Reparatur aendern', ort: 'pages/repairs/RepairDetail.tsx',
    lokal: 'updateRepairOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5C — EIN Schreibsatz (buildRepairEditPatch) fuer „Save" am Primary und den Fernbefehl: jedes Feld der Maske, auch Zahlwege, Kartenart, Kategorie, Merkmale, Referenz, Beschreibung und Fotos. Eigene Kosten, Marge und Kartenart leitet der Primary aus dem Stand NACH der Aenderung ab; die Umbuchung der Kundenzahlung samt Kartengebuehr macht dieselbe Hausfunktion (updateRepair) in derselben Klammer.',
  },
  {
    op: 'repairs.update_status', handlung: 'Reparaturstatus setzen', ort: 'pages/repairs/RepairDetail.tsx',
    lokal: 'updateStatus', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; Kapitalisierung und Bestand folgen im Haus — fassungsbasiert.',
  },
  {
    op: 'repairs.create_invoice', handlung: 'Rechnung zur Reparatur', ort: 'pages/repairs/RepairList.tsx',
    lokal: 'invoiceRepairsOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5C — EINE Hausfunktion (createCombinedRepairInvoice) fuer Sammelrechnung, Kuerzel und Detailseite; der Fernbefehl nimmt eine oder mehrere Reparaturen desselben Kunden, jede mit ihrer gesehenen Fassung, dazu die Wahl der Dialoge (Steuer, Nummernart). EINE Regel „abrechenbar" (repairInvoiceBlocker). Beleg, alle Verknuepfungen und Buchung in EINER Klammer.',
  },
  {
    op: 'repairs.add_line', handlung: 'Reparaturposition hinzufuegen', ort: 'pages/repairs/RepairDetail.tsx',
    lokal: 'addRepairLine', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf mit Werkstatt, Art, Beschreibung, Kosten und Termin. R4C.4 hat die zweite Arbeitsart-Liste des Fernbefehls entfernt: beide Seiten lesen jetzt REPAIR_WORK_TYPES. Die MATERIAL-Maske derselben Seite bleibt eine andere Handlung (Materialart, Materialdetails, auf Wunsch eine Gold-Verbindlichkeit) und dem Hauptrechner vorbehalten.',
  },
  {
    op: 'repairs.update_line', handlung: 'Reparaturposition aendern', ort: '(keine)',
    lokal: 'updateRepairLine', paritaet: 'keine-ui', verdrahtet: false, luecke: null,
    grund: 'Die gemeinsame Oberflaeche bietet das Aendern einer Position nicht an — nur der '
      + 'Pruefstand (Maschinenflaeche) tut es. Nichts zu verdrahten.',
  },
  {
    op: 'repairs.cancel_line', handlung: 'Reparaturposition stornieren', ort: 'pages/repairs/RepairDetail.tsx',
    lokal: 'cancelRepairLine', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; die verknuepfte Gold-Verbindlichkeit raeumt das Haus mit ab.',
  },

  // ── Agenten-Transfers ────────────────────────────────────────────────────
  {
    op: 'transfers.create', handlung: 'Transfer an einen Kunden', ort: 'pages/agents/AgentList.tsx',
    lokal: 'createTransferOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5D — EINE Folge fuer beide Seiten (core/agents/transfer-house: createTransferInHouse, Regeln in transfer-rules): Kunde der Auswahl, das Stueck im Lager und nicht schon draussen, Our Price > 0, Abrechnungsmodell mit Anteil 0–100 (sonst 50), Rueckgabedatum und — der alte Grund — der Mitarbeiter (`staffId`, nur ein aktiver der Filiale). Agent, Nummer, Bestandswechsel und Zeitpunkte setzt der Primary; am Primary in EINER Klammer.',
  },
  {
    op: 'transfers.update', handlung: 'Transfer aendern', ort: 'components/agents/TransferTable.tsx',
    lokal: 'updateTransfer', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf mit genau den drei Feldern der Maske: Preis, Rueckgabedatum, Notiz.',
  },
  {
    op: 'transfers.mark_returned', handlung: 'Transfer zurueckgenommen', ort: 'components/agents/TransferTable.tsx',
    lokal: 'markTransferReturned', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; der Bestand folgt im Haus.',
  },
  {
    op: 'transfers.mark_sold', handlung: 'Transfer verkauft', ort: 'components/agents/TransferTable.tsx',
    lokal: 'markTransferSold', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf mit dem Verkaufspreis.',
  },
  {
    op: 'transfers.mark_settled', handlung: 'Transfer abgerechnet', ort: '(keine)',
    lokal: 'markTransferSettled', paritaet: 'keine-ui', verdrahtet: false, luecke: null,
    grund: 'Die gemeinsame Oberflaeche kennt keine eigene Handlung dafuer: „abgerechnet" ergibt '
      + 'sich dort aus einer vollstaendig bezahlten Rechnung. Nichts zu verdrahten.',
  },
  {
    op: 'transfers.convert_to_invoice', handlung: 'Transfer in Rechnung wandeln', ort: 'components/agents/TransferTable.tsx',
    lokal: 'convertTransferOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5D — „Auto-create from agent" ist Teil DERSELBEN Buchung: der Auftrag sagt nur `autoCustomer: true`, den Kunden legt der Primary aus den Angaben des Agenten an (Name, Firma, Kontakte und Vermerk wie die Maske, ohne Abgleich) — in EINER Klammer mit Rechnung, Verknuepfung und Storno der Verkaufsforderung. Sonst ein gewaehlter Kunde der Filiale. Liste und Detailseite rufen dieselbe Folge (convertTransferInHouse).',
  },
  {
    op: 'transfers.convert_many_to_invoice', handlung: 'Mehrere Transfers in eine Rechnung', ort: 'components/agents/TransferTable.tsx',
    lokal: 'convertTransfersOnPrimary', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'R5D — dieselbe Folge fuer mehrere VERKAUFTE Transfers EINES Agenten (canCombineTransfer): EINE Rechnung, Zeilen in der Reihenfolge der Auswahl, jeder Transfer mit seiner gesehenen Fassung, ggf. der neue Kunde aus dem Agenten — alles oder nichts (convertTransfersInHouse).',
  },
];
