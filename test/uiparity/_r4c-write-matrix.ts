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
    lokal: 'createProductWithMedia', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske legt Artikel MIT Bildern an; die Fernbuchung nimmt nur zwischengespeicherte '
      + 'Bildkennungen. Ohne den Zwischenspeicher-Weg waere es die halbe Handlung.',
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
    lokal: 'createPurchase', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske legt Positionen mit NEUEN Artikeln an (`newProduct`, Marke/Name/SKU/Kategorie) und schickt `staffId` sowie `sourceOrderId` mit. Die Fernbuchung nimmt ausschliesslich Zeilen mit vorhandener Artikelkennung — der Einkauf beim Wareneingang eines Auftrags waere nicht derselbe.',
  },

  // ── Kommission ───────────────────────────────────────────────────────────
  {
    op: 'consignments.create', handlung: 'Kommission anlegen', ort: 'pages/consignments/ConsignmentList.tsx',
    lokal: 'createConsignment', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske legt in derselben Handlung auch den ARTIKEL an (createProduct) und haengt '
      + 'die Kommission daran; die Fernbuchung erwartet einen vorhandenen Artikel.',
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
    lokal: 'createOrder', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske legt in derselben Handlung eine GOLD-VERBINDLICHKEIT beim Goldschmied an (`createGoldPayable` mit Gramm und Karat, verknuepft an die eben entstandene Zeile). Die Fernbuchung legt nur den Auftrag an — das Gold bliebe unverbucht.',
  },
  {
    op: 'orders.update', handlung: 'Auftrag aendern', ort: 'pages/orders/OrderDetail.tsx',
    lokal: 'updateOrder', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske schickt `expectedMargin` und `remainingAmount` mit — beides abgeleitete Zahlen, die die Fernbuchung nicht entgegennimmt. Ohne sie stuende auf dem Auftrag etwas anderes als nach demselben Klick am Hauptrechner.',
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
    grund: 'R5A — die Fernbuchung fuehrt jetzt den Anzahlungsuebertrag MIT aus, in derselben Transaktion und ueber DIESELBE Funktion wie die Auftragsansicht (core/orders/order-payment-carryover). Eine Handlung, eine Buchung, kein liegengebliebenes Geld.',
  },

  // ── Reparaturen ──────────────────────────────────────────────────────────
  {
    op: 'repairs.create', handlung: 'Reparatur anlegen', ort: 'pages/repairs/RepairList.tsx',
    lokal: 'createRepair', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske legt Kunden- UND Eigenreparaturen an (repairScope OWN mit Losauswahl und '
      + 'Kapitalisierung); die Fernbuchung setzt repairScope fest auf CUSTOMER.',
  },
  {
    op: 'repairs.update', handlung: 'Reparatur aendern', ort: 'pages/repairs/RepairDetail.tsx',
    lokal: 'updateRepair', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske schickt sechs Felder, die die Fernbuchung nicht kennt: `customerPaidFrom`, `customerCardBrand`, `internalPaidFrom`, `margin`, `itemCategoryId`, `itemAttributes`. Darunter die Zahlwege — das ist Geld, nicht Beschriftung.',
  },
  {
    op: 'repairs.update_status', handlung: 'Reparaturstatus setzen', ort: 'pages/repairs/RepairDetail.tsx',
    lokal: 'updateStatus', paritaet: 'exakt', verdrahtet: true, luecke: null,
    grund: 'Ein Aufruf; Kapitalisierung und Bestand folgen im Haus — fassungsbasiert.',
  },
  {
    op: 'repairs.create_invoice', handlung: 'Rechnung zur Reparatur', ort: 'pages/repairs/RepairList.tsx',
    lokal: 'createCombinedRepairInvoice', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Liste rechnet auch MEHRERE Reparaturen in EINE Rechnung ab (Sammelabrechnung ueber '
      + 'die Auswahl); die Fernbuchung kennt nur genau eine Reparatur. Zwei verschiedene Handlungen '
      + 'unter einem Knopf — deshalb erst trennen, dann verdrahten.',
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
    lokal: 'createTransferForCustomer', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske schickt `staffId` mit (wer den Transfer verantwortet); die Fernbuchung kennt das Feld nicht.',
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
    lokal: 'convertTransferToInvoice', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Die Maske legt im Modus „auto\' in derselben Handlung erst den KUNDEN aus dem Agenten an (`createCustomer` mit Name, Firma, Telefon, E-Mail) und wandelt dann um. Die Fernbuchung wandelt nur um. Erst trennen, dann verdrahten.',
  },
  {
    op: 'transfers.convert_many_to_invoice', handlung: 'Mehrere Transfers in eine Rechnung', ort: 'components/agents/TransferTable.tsx',
    lokal: 'convertTransfersToInvoice', paritaet: 'enger', verdrahtet: false, luecke: 'B',
    grund: 'Dieselbe Handlung fuer mehrere Transfers — und derselbe Grund: im Modus „auto\' entsteht zuerst ein neuer Kunde aus dem Agenten.',
  },
];
