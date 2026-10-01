// ════════════════════════════════════════════════════════════════════════════
// INVOICE-A5 — der Druckbeleg der Rechnung (A5): Firma aus den Einstellungen, Zeilen mit Steuer,
// Summen, Betrag in Worten, Margin-Hinweis, und dass „PDF" und „Print" genau diesen Beleg drucken.
// Run: node test/invoice-a5/invoice-a5.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INVOICE_COMPANY_DEFAULTS, INVOICE_COMPANY_KEYS, amountInWordsBhd, buildInvoiceA5Data, invoiceA5Html, invoiceCompany,
  invoiceDateText, lineDetails, paymentModeText,
} from '../../src/core/pdf/invoice-a5.ts';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);

// ── Firma: Einstellungen vor Vorgabe, leer heißt Vorgabe ──
{
  const leer = invoiceCompany(() => '');
  ok(S(leer) === S(INVOICE_COMPANY_DEFAULTS) && leer.nameEn === 'LATAIF JEWELLERY W.L.L.' && leer.crNumber === '137216-1' && leer.vatNumber === '220015625500002',
    'FIRMA ohne Einstellungen: der Kopf der Vorlage (Name, CR, VAT, Adresse, Telefon, E-Mail)');
  const gesetzt = invoiceCompany((k) => ({ [INVOICE_COMPANY_KEYS.vatNumber]: ' 999 ', [INVOICE_COMPANY_KEYS.phone]: '+973 1700 0000', [INVOICE_COMPANY_KEYS.nameAr]: '   ' } as Record<string, string>)[k] ?? '');
  ok(gesetzt.vatNumber === '999' && gesetzt.phone === '+973 1700 0000' && gesetzt.nameAr === INVOICE_COMPANY_DEFAULTS.nameAr,
    'FIRMA eine gesetzte Einstellung gilt (getrimmt), ein leerer Wert fällt auf die Vorgabe');
  ok(invoiceCompany(() => { throw new Error('keine Datenbank'); }).nameEn === INVOICE_COMPANY_DEFAULTS.nameEn, 'FIRMA ohne lesbare Einstellungen (z. B. zweiter Rechner) druckt trotzdem');
}

// ── Schreibweisen ──
ok(amountInWordsBhd(16100) === 'Bahrain Dinars Sixteen Thousand One Hundred Only', `WORTE 16.100 (${amountInWordsBhd(16100)})`);
ok(amountInWordsBhd(6600.5) === 'Bahrain Dinars Six Thousand Six Hundred and Five Hundred Fils Only'
  && amountInWordsBhd(0.25) === 'Bahrain Dinars Zero and Two Hundred Fifty Fils Only'
  && amountInWordsBhd(1000001) === 'Bahrain Dinars One Million One Only'
  && amountInWordsBhd(115.075) === 'Bahrain Dinars One Hundred Fifteen and Seventy Five Fils Only', 'WORTE mit Fils, null Dinar, Millionen');
ok(invoiceDateText('2026-08-31') === '31-Aug-26' && invoiceDateText('2026-01-05T09:00:00.000Z') === '05-Jan-26' && invoiceDateText('') === '—', 'DATUM „31-Aug-26"');
ok(paymentModeText([], 0, 100) === 'Credit' && paymentModeText(['cash'], 100, 0) === 'Cash'
  && paymentModeText(['cash', 'card', 'cash'], 50, 50) === 'Cash / Card / Credit' && paymentModeText(['bank_transfer', 'benefit'], 10, 0) === 'Bank Transfer / Benefit'
  && paymentModeText([], 100, 0) === 'Paid' && paymentModeText([], 40, 60) === 'Partially Paid', 'ZAHLUNG „Credit" ohne Zahlung, sonst die Wege; unbekannte Wege werden nicht erfunden');

// ── Zeilen ──
const products = [
  { id: 'w', brand: 'Rolex', name: 'Datejust 36', sku: 'LAT-W-0042', categoryId: 'cat-watch', condition: 'Used', attributes: { reference_number: '16233', serial_number: 'W123456', case_diameter_mm: 36, dial: 'Champagne', bezel: 'Fluted', material: 'Two-Tone Steel/Gold', karat_color: '18K Yellow', strap_type: 'Jubilee', year: 2019, description: 'Box' } },
  { id: 'c', brand: 'Cartier', name: 'Love Bracelet', categoryId: 'cat-branded-gold-jewelry', condition: 'Used', attributes: JSON.stringify({ model_number: 'B6035517', size: '17' }) },
  { id: 'g', brand: '', name: '', categoryId: 'cat-gold-jewelry', condition: 'Excellent', attributes: { item_type: 'Ring', karat: '18K White', weight: 4.2, size: '54', stones: [{ type: 'diamond', qty: 1, carat: 0.5 }] } },
];
ok(S(lineDetails(products[0])) === S(['Ref: 16233', 'Serial: W123456', '36 mm', 'Champagne', 'Fluted', 'Two-Tone Steel/Gold', '18K Yellow', 'Jubilee'])
  && S(lineDetails({ id: 'w2', categoryId: 'cat-watch', condition: 'New', attributes: { reference_number: '5711', case_diameter_mm: '40.5 mm', dial: '' } })) === S(['Ref: 5711', '40.5 mm'])
  && S(lineDetails(products[1])) === S(['Ref: B6035517', 'Size: 17'])
  && S(lineDetails(products[2])) === S(['Size: 54', 'Diamond 0.50 ct'])
  && S(lineDetails({ id: 'g2', brand: '', name: 'Baguette Diamond Ring', categoryId: 'cat-gold-jewelry', condition: 'Pre-Owned', attributes: { karat: '18K White', weight: 3.1, diamond_weight: 0.6 } }))
    === S(['18K White', '3.10 g', 'Diamond 0.60 ct'])
  && S(lineDetails({ id: 'o1', brand: 'Cartier', name: 'Love', categoryId: 'cat-original-gold-jewelry', condition: 'Pre-Owned', attributes: { item_type: 'Bangle', karat: '18K Yellow', serial_number: 'WZY157', size: '16', weight: 8.5, year: 2024 } }))
    === S(['Bangle', 'Serial: WZY157', 'Size: 16', '18K Yellow', '8.50 g'])
  && S(lineDetails({ id: 'o2', brand: 'Cartier', name: 'Love Bracelet', categoryId: 'cat-original-gold-jewelry', condition: 'Pre-Owned', attributes: { item_type: 'Bracelet', karat: '18K Yellow', serial_number: 'GJI904' } }))
    === S(['Serial: GJI904', '18K Yellow'])
  && S(lineDetails({ id: 'a1', brand: 'Hermès', name: 'Clic H', categoryId: 'cat-accessory', condition: 'Pre-Owned', attributes: { item_type: 'Other', serial_number: 'DF0254' } })) === S(['Serial: DF0254']),
  `ZEILE Kurzangaben: keine Condition; Bezeichnung nur bei Ref, Serial, Size; Schmuck mit Art, Karat, Gewicht, Diamanten (nicht doppelt zum Namen) (${S(lineDetails(products[0]))})`);

const firma = invoiceCompany(() => '');
const basis = {
  company: firma, products, paymentMethods: [] as string[], salesperson: 'Sara',
  customer: { firstName: 'Ali', lastName: 'Hassan', personalId: '880101234', phone: '+973 3600 0101', vatAccountNumber: '', company: '' },
};
const margin = buildInvoiceA5Data({ ...basis, invoice: { number: 'B0712', status: 'FINAL', issuedAt: '2026-08-31', grossAmount: 9500, paidAmount: 0,
  lines: [
    { productId: 'w', quantity: 1, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 180, lineTotal: 4500 },
    { productId: 'g', quantity: 2, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 90, lineTotal: 5000 },
  ] } });
ok(margin.title === 'TAX INVOICE' && margin.marginNotice && margin.lines.every((l) => l.vatPct === 0 && l.vatAmount === 0)
  && margin.lines[1].rate === 2500 && margin.lines[1].qty === 2 && margin.lines[0].rate === 4500,
  'MARGIN keine Steuer auf dem Beleg (0 %, 0.000), Preis inklusive, Stückpreis je Menge — und der Margin-Hinweis');
ok(margin.subtotal === 9500 && margin.vatTotal === 0 && margin.grandTotal === 9500 && margin.vatLabel === 'VAT Amount (0%)'
  && margin.amountInWords === 'Bahrain Dinars Nine Thousand Five Hundred Only', 'MARGIN Summen wie die Vorlage: Subtotal = Grand Total, VAT (0%)');
ok(margin.lines[1].description === 'Ring · 18K White · 4.20 g', `MARGIN Gold ohne Marke/Modell: der eine Anzeigename (${margin.lines[1].description})`);
ok(S(margin.customer) === S([['Name', 'Ali Hassan'], ['ID/CR', '880101234'], ['Mobile', '+973 3600 0101']])
  && S(margin.invoice) === S([['Invoice No.', 'B0712'], ['Date', '31-Aug-26'], ['Payment Mode', 'Credit'], ['Salesperson', 'Sara']]) && !S(margin).includes('Branch') && !S(margin).includes('Address'),
  `KOPF Kunde nur mit vorhandenen Angaben; Rechnungsangaben vollständig (${S(margin.customer)})`);

const gemischt = buildInvoiceA5Data({ ...basis, paymentMethods: ['cash'], invoice: { number: 'B0713', status: 'PARTIAL', issuedAt: '2026-09-30', grossAmount: 6600.5, paidAmount: 2000,
  lines: [
    { productId: 'w', quantity: 1, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 50, lineTotal: 5500.5 },
    { productId: 'c', quantity: 1, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 100, lineTotal: 1100 },
  ] } });
const z = gemischt.lines[1];
ok(z.rate === 1000 && z.vatPct === 10 && z.vatAmount === 100 && z.amount === 1100, `10 % netto 1000 + VAT 100 = 1100 (${S(z)})`);
ok(gemischt.subtotal === 6500.5 && gemischt.vatTotal === 100 && gemischt.grandTotal === 6600.5 && gemischt.vatLabel === 'VAT Amount (10%)'
  && gemischt.paid === 2000 && gemischt.balance === 4600.5 && gemischt.invoice[2][1] === 'Cash / Credit', 'GEMISCHT Subtotal + VAT = Grand Total; bezahlt und offen');

const ohneMargin = buildInvoiceA5Data({ ...basis, invoice: { number: 'P-1', status: 'DRAFT', issuedAt: null, createdAt: '2026-09-01', grossAmount: 1100, paidAmount: 0,
  lines: [{ productId: 'c', quantity: 1, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 100, lineTotal: 1100 }] } });
const storniert = buildInvoiceA5Data({ ...basis, invoice: { number: 'B0714', status: 'CANCELLED', issuedAt: '2026-09-01', grossAmount: 1100, paidAmount: 0,
  lines: [{ productId: 'c', quantity: 1, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 100, lineTotal: 1100 }] } });
ok(ohneMargin.title === 'PROFORMA INVOICE' && !ohneMargin.marginNotice && ohneMargin.invoice[1][1] === '01-Sep-26' && storniert.stamp === 'CANCELLED' && storniert.title === 'TAX INVOICE',
  'STATUS Entwurf = Proforma, storniert = Stempel, ohne Margin-Zeile kein Hinweis');
ok(gemischt.title === 'ADVANCE PAYMENT INVOICE' && margin.title === 'TAX INVOICE' && invoiceA5Html(gemischt).includes('<h1>ADVANCE PAYMENT INVOICE</h1>'),
  'STATUS angezahlt (PARTIAL) = „Advance Payment Invoice", final = „Tax Invoice"');

// ── HTML ──
{
  const h = invoiceA5Html(margin);
  ok(/@page \{ size: A5 portrait;/.test(h) && /<h1>TAX INVOICE<\/h1>/.test(h), 'HTML Seitenformat A5 hoch, Titel „TAX INVOICE"');
  ok(['Item Description', 'Qty', 'Rate<span>(BHD)</span>', 'VAT<span>%</span>', 'VAT Amount<span>(BHD)</span>', 'Amount<span>(BHD)</span>', 'Customer Details', 'Invoice Details',
    'Amount in Words :', 'Subtotal', 'Grand Total', 'VAT HAS BEEN IMPOSED USING THE PROFIT MARGIN SCHEME', 'Terms &amp; Conditions:', 'Customer’s Signature', 'Authorised Signatory']
    .every((t) => h.includes(t)), 'HTML alle Teile der Vorlage: Spalten, Kunde/Rechnung, Worte, Summen, Hinweis, Bedingungen, Unterschriften');
  ok(h.includes('<div class="d-title"><span>Rolex Datejust 36</span><span class="d-sku">SKU: LAT-W-0042</span></div>') && !h.includes('<span class="d-it">SKU:'), 'HTML die SKU steht klein neben dem Namen, nicht in den Angaben');
  ok(h.includes('<div><span class="sl"></span>Customer’s Signature</div>') && h.includes('<div><span class="sl"></span>Authorised Signatory</div>'),
    'HTML Unterschriften: erst der Strich, darunter die Beschriftung');
  ok(h.indexOf('+973 36211681') < h.indexOf('lataifwll@gmail.com') && h.indexOf('lataifwll@gmail.com') < h.indexOf('<span>@rahmatbahrain</span>')
    && invoiceA5Html({ ...margin, company: { ...margin.company, instagram: '@lataif' } }).includes('<span>@lataif</span>')
    && !invoiceA5Html({ ...margin, company: { ...margin.company, instagram: '' } }).includes('<span>@'),
    'FUSSZEILE Instagram nach Telefon und E-Mail (ein @, auch wenn eingetragen); leer = keins');
  ok(h.includes('LATAIF JEWELLERY <small>W.L.L.</small>') && h.includes('مجوهرات لطائف ذ.م.م') && h.includes('<bdi dir="ltr">137216-1</bdi>')
    && h.includes('<bdi dir="ltr">220015625500002</bdi>') && h.includes('lataifwll@gmail.com'), 'HTML Kopf Englisch/Arabisch, Nummern im arabischen Teil nicht gespiegelt, Fußzeile');
  ok(h.includes('<b>CR No.:</b> 137216-1') && h.includes('<b>VAT No.:</b> 220015625500002')
    && h.includes('<b>س.ت:</b> <bdi dir="ltr">137216-1</bdi>') && h.includes('<b>الرقم الضريبي:</b> <bdi dir="ltr">220015625500002</bdi>'),
    'HTML CR/VAT: auf beiden Seiten die Bezeichnung fett, die Nummer normal');
  ok(/<thead>/.test(h) && /table\.items thead \{ display: table-header-group; \}/.test(h) && /break-inside: avoid/.test(h), 'HTML lange Rechnung: Tabellenkopf wiederholt sich, Zeilen brechen nicht');
  ok(h.includes('<td class="num">4,500.000</td>') && h.includes('<td class="c-qty">2 pcs</td>'), 'HTML Beträge mit drei Nachkommastellen, Menge in Stück');
  const boese = invoiceA5Html(buildInvoiceA5Data({ ...basis, customer: { firstName: '<img src=x onerror=alert(1)>', lastName: '&' },
    invoice: { number: 'B"1', status: 'FINAL', issuedAt: '2026-09-01', grossAmount: 1, paidAmount: 0, lines: [{ productId: 'x', description: '<b>Service</b>', quantity: 1, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1 }] } }));
  ok(!boese.includes('<img src=x') && boese.includes('&lt;img src=x onerror=alert(1)&gt; &amp;') && boese.includes('&lt;b&gt;Service&lt;/b&gt;') && boese.includes('B&quot;1'),
    'HTML alles Eingegebene wird maskiert (Name, Beschreibung, Nummer)');
  const mitBildern = invoiceA5Html({ ...margin, logos: { emblem: 'data:image/png;base64,EMB', nameEn: 'data:image/png;base64,EN', nameAr: 'data:image/png;base64,AR' } });
  ok(mitBildern.includes('<img class="emblem-img" src="data:image/png;base64,EMB"') && mitBildern.includes('<img class="name-img" src="data:image/png;base64,EN" alt="LATAIF JEWELLERY W.L.L."')
    && mitBildern.includes('<img class="name-img" src="data:image/png;base64,AR" alt="مجوهرات لطائف ذ.م.م"') && !mitBildern.includes('<svg class="emblem"')
    && mitBildern.indexOf('base64,EN') < mitBildern.indexOf('base64,EMB') && mitBildern.indexOf('base64,EMB') < mitBildern.indexOf('base64,AR'),
    'KOPF mit Bildern: links Englisch, Mitte Emblem, rechts Arabisch; ohne Bilder Text und gezeichnetes Emblem');
  ok(!invoiceA5Html(ohneMargin).includes('PROFIT MARGIN SCHEME') && invoiceA5Html(storniert).includes('<div class="stamp">CANCELLED</div>'), 'HTML Hinweis nur mit Margin-Zeile; Stempel bei Storno');
}

// ── Verdrahtung ──
{
  const seite = src('src/pages/invoices/InvoiceDetail.tsx');
  ok(/onClick=\{printInvoice\}><Download size=\{14\} \/> PDF<\/Button>/.test(seite) && /onClick=\{printInvoice\} className="no-print"><Printer size=\{14\} \/> Print<\/Button>/.test(seite),
    'SEITE „PDF" und „Print" drucken den A5-Beleg');
  ok(/const t = setTimeout\(\(\) => druckRef\.current\(\), 400\);/.test(seite) && /druckRef\.current = printInvoice;/.test(seite) && !/handleDownloadPdf/.test(seite),
    'SEITE „Save & Print" druckt ebenfalls den A5-Beleg — mit geladenen Artikeln');
  ok(/company: invoiceCompany\(\(key\) => getSetting\(key\)\)/.test(seite) && /paymentMethods: getInvoicePayments\(invoice\.id\)/.test(seite), 'SEITE Firma aus den Einstellungen, Zahlungswege aus den Zahlungen');
  const einst = src('src/pages/settings/SettingsPage.tsx');
  ok(/\['crNumber', 'CR No\.'\], \['vatNumber', 'VAT No\.'\], \['instagram', 'Instagram'\], \['terms', 'Invoice Terms'\]/.test(einst)
    && /setSetting\(branchId, INVOICE_COMPANY_KEYS\[k\]/.test(einst), 'EINSTELLUNGEN CR, VAT und Bedingungen sind unter Company Information änderbar');
  const logos = src('src/core/pdf/invoice-a5-logos.ts');
  ok(/logos: invoiceA5Logos\(\),/.test(seite) && /import emblemUrl from '@\/assets\/invoice-emblem\.png';/.test(logos)
    && /invoice-name-en\.png/.test(logos) && /invoice-name-ar\.png/.test(logos), 'SEITE der Kopf druckt Emblem und Schriftzüge der Firma');
}

console.log(`\ninvoice-a5: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('INVOICE_A5_PROVED');
