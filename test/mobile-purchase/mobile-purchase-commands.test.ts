// ════════════════════════════════════════════════════════════════════════════
// MOBILE-PURCHASE — die Befehlsseite des Telefons (ohne DOM): Entwurf, Pruefung, Summen,
// Partneranteile (Prozent und BHD), Zahlungen, Zusammenfassungen, Rumpf von `purchases.create`.
// Run: node test/mobile-purchase/mobile-purchase-commands.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);

// Beide Dateien woertlich — so, wie die Handy-Seite sie einbettet.
const sandbox: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
new Function('self', src('src-tauri/src/sync/mobile_purchase_commands.js'))(sandbox);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const MP = sandbox.MobilePurchase as any;

const { planLineParticipation } = await import('../../src/core/partners/item-participation.ts');

// ── Vokabeln an der Quelle ──
{
  const pc = src('src/core/purchases/purchase-create.ts');
  const m = /PURCHASE_PAYMENT_METHODS = \[([^\]]*)\]/.exec(pc);
  const tx = /PURCHASE_TAX_SCHEMES = \[([^\]]*)\]/.exec(pc);
  const words = (x: RegExpExecArray | null) => (x ? x[1].split(',').map((w) => w.trim().replace(/'/g, '')).filter(Boolean) : []);
  ok(S(MP.PAYMENT_METHODS) === S(words(m)) && S(MP.TAX_SCHEMES) === S(words(tx)), `VOKABELN Zahlungswege und Vorsteuer wie am Primary (${S(MP.PAYMENT_METHODS)})`);
  ok(MP.MAX_PHOTOS === 8 && MP.MAX_PAYMENTS === 10 && MP.MAX_ITEMS === 100, 'GRENZEN 8 Fotos je Position, 10 Zahlungen, 100 Positionen');
}

function draft() {
  const d = MP.newDraft('d-1', '2026-09-28');
  d.supplier.mode = 'existing'; d.supplier.supplierId = 'sup-1'; d.supplier.name = 'Test Supplier';
  return d;
}
function item(uid: string, extra: Record<string, unknown> = {}) {
  return Object.assign(MP.newItem(uid, 'cat-watches'), { brand: 'Rolex', name: 'Sub ' + uid, quantity: '1', unitPrice: '100' }, extra);
}

// ── Summen filsgenau ──
{
  const d = draft();
  d.items.push(item('a', { quantity: '1', unitPrice: '900' }), item('b', { quantity: '3', unitPrice: '120.5' }), item('c', { quantity: '2', unitPrice: '0.1' }));
  d.payments.push({ method: 'cash', amount: '500', reference: '' }, { method: 'benefit', amount: '400.2', reference: '' });
  const t = MP.totals(d);
  ok(t.positions === 3 && t.pieces === 6 && t.totalF === 1261700 && t.paidF === 900200 && t.openF === 361500,
    `SUMMEN 900 + 361,5 + 0,2 = 1261,7; bezahlt 900,2; offen 361,5 (${S(t)})`);
  ok(MP.itemsSummary(d) === '3 positions · 6 pcs · 1,261.700 BHD' && MP.paymentsSummary(d) === '900.200 / 1,261.700 BHD paid · 361.500 open',
    `ZUSAMMENFASSUNG Items und Payments (${MP.itemsSummary(d)} | ${MP.paymentsSummary(d)})`);
  ok(MP.supplierSummary(d) === 'Test Supplier' && MP.statusLabel('pending') === 'Waiting for main computer' && MP.statusLabel('confirmed') === 'Booked',
    'ZUSAMMENFASSUNG Lieferant und Zustaende');
}

// ── Partner: Prozent aus BHD, Aufteilung wie der Primary ──
{
  ok(MP.pctOfAmount('400', 1000) === 40 && MP.pctOfAmount('333.333', 500) === 66.67 && MP.pctOfAmount('', 500) === null,
    'BHD → PROZENT 400 von 1000 = 40 %, 333,333 von 500 = 66,67 % (0,01 %-Rundung wie am Rechner)');
  const faelle: Array<[string, string, Array<[string, number]>]> = [
    ['1', '1000', [['pa-1', 40]]], ['2', '250', [['pa-1', 36.67], ['pa-2', 30]]], ['3', '333.333', [['pa-1', 33.33], ['pa-2', 33.33], ['pa-3', 33.34]]],
  ];
  for (const [q, p, shares] of faelle) {
    const it = item('x', { quantity: q, unitPrice: p, partners: shares.map(([id, pct]) => ({ partnerId: id, sharePct: String(pct) })) });
    const b = MP.shareBreakdown(it);
    const plan = planLineParticipation(shares.map(([partnerId, sharePct]) => ({ partnerId, sharePct })), MP.lineTotalF(it));
    const same = plan[0].costShareF === b.houseCostF && plan[0].shareBp === b.houseBp
      && plan.slice(1).every((r, i) => r.costShareF === b.rows[i].costF && r.shareBp === b.rows[i].bp);
    ok(same, `AUFTEILUNG wie planLineParticipation (${q} × ${p}, ${S(shares)}): ${S(b)}`);
  }
  const it = item('y', { partners: [{ partnerId: 'pa-1', sharePct: '40' }] });
  ok(MP.partnerSummary(it) === 'Partner 40 % · LATAIF 60 %' && MP.partnerSummary(item('z')) === 'LATAIF alone', 'ZUSAMMENFASSUNG Partner');
}

// ── Pruefung ──
{
  const codes = (d: unknown, o?: unknown) => MP.validate(d, o).map((x: { code: string }) => x.code);
  const d0 = MP.newDraft('d', '2026-09-28');
  ok(S(codes(d0)) === S(['SUPPLIER_REQUIRED', 'LINES_REQUIRED']), `PRUEFUNG ohne Lieferant und Position (${S(codes(d0))})`);
  const d = draft();
  d.items.push(item('a', { quantity: '0' }), item('b', { quantity: '1.5' }), item('c', { unitPrice: 'abc' }), item('d', { brand: '' }));
  ok(S(codes(d)) === S(['QTY_INVALID', 'QTY_INVALID', 'PRICE_INVALID', 'LINE_INVALID']), `PRUEFUNG Menge 0, Menge 1,5, Preis, Marke (${S(codes(d))})`);
  const e = draft();
  e.items.push(item('a', { partners: [{ partnerId: 'pa-1', sharePct: '60' }, { partnerId: 'pa-1', sharePct: '50' }] }));
  e.payments.push({ method: 'card', amount: '10' }, { method: 'cash', amount: '0' }, { method: 'cash', amount: '200' });
  ok(S(codes(e)) === S(['PARTNER_DUPLICATE', 'PARTNER_SHARES_INVALID', 'PAYMENT_METHOD_INVALID', 'PAYMENT_AMOUNT_INVALID', 'PAYMENT_EXCEEDS_TOTAL']),
    `PRUEFUNG Partner doppelt/über 100 %, Karte, 0, Zahlungen über Summe (${S(codes(e))})`);
  const f = draft();
  f.items.push(item('a'));
  ok(S(codes(f, { fieldErrors: [['Reference is required.']] })) === S(['FIELD_INVALID']), 'PRUEFUNG Pflichtmerkmale der Kategorie werden gemeldet');
  const g = draft(); g.items.push(item('a', { mode: 'existing', productId: '' }));
  ok(S(codes(g)) === S(['PRODUCT_REQUIRED']), 'PRUEFUNG bestehender Artikel muss gewählt sein');
}

// ── Rumpf ──
{
  const d = draft();
  d.taxScheme = 'VAT_10';
  d.notes = '  Kasse 2 ';
  d.items.push(
    item('a', { quantity: '1', unitPrice: '900', sku: 'R-1', condition: 'Excellent', attributes: { reference: '126334' }, scopeOfDelivery: ['Box'], itemNotes: 'Glas', photos: [{ id: 'p1', dataUrl: 'data:image/jpeg;base64,AAAA' }, { id: 'p2', dataUrl: 'data:image/jpeg;base64,BBBB' }], partners: [{ partnerId: 'pa-1', sharePct: '40', amount: '360' }] }),
    item('b', { mode: 'existing', productId: 'p-9', productLabel: 'Ring', quantity: '2', unitPrice: '50' }),
  );
  d.payments.push({ method: 'cash', amount: '500', reference: '' }, { method: 'bank', amount: '100', reference: 'TR-1' });
  const ids = (it: { photos: Array<{ id: string }> }) => it.photos.map((p) => 'sha-' + p.id);
  const r = MP.buildBody(d, ids);
  const b = r.body;
  ok(r.ok && b.supplierId === 'sup-1' && b.taxScheme === 'VAT_10' && b.purchaseDate === '2026-09-28' && b.notes === 'Kasse 2', `RUMPF Kopf (${S({ ...b, lines: undefined })})`);
  ok(S(b.lines[0]) === S({ mode: 'new', brand: 'Rolex', name: 'Sub a', sku: 'R-1', categoryId: 'cat-watches', quantity: 1, unitPrice: 900,
    newProduct: { categoryId: 'cat-watches', brand: 'Rolex', name: 'Sub a', sku: 'R-1', condition: 'Excellent', attributes: { reference: '126334' }, scopeOfDelivery: ['Box'], notes: 'Glas', stagingIds: ['sha-p1', 'sha-p2'] },
    partnerShares: [{ partnerId: 'pa-1', sharePct: 40 }] }), `RUMPF neue Position mit Merkmalen, Fotos als Ablagekennungen, Partner (${S(b.lines[0])})`);
  ok(S(b.lines[1]) === S({ mode: 'existing', brand: '', name: '', sku: '', categoryId: '', quantity: 2, unitPrice: 50, productId: 'p-9' }), 'RUMPF bestehender Artikel');
  ok(S(b.payments) === S([{ amount: 500, method: 'cash' }, { amount: 100, method: 'bank', reference: 'TR-1' }]) && !('paymentAmount' in b), 'RUMPF mehrere Zahlungen, keine Anzahlung daneben');
  ok(!/base64|data:image/.test(S(b)), 'RUMPF keine Bildbytes im Auftrag');
  ok(S(MP.buildBody(d, ids)) === S(r), 'RUMPF derselbe Entwurf ergibt denselben Rumpf (Wiederholung = derselbe Auftrag)');
  const c = draft(); c.supplier = { mode: 'customer', customerId: 'cust-1', customerUpdatedAt: '2026-01-01', name: 'Ali', person: {}, createDespite: false }; c.items.push(item('a'));
  const cb = MP.buildBody(c, () => []).body;
  ok(S(cb.supplierFromCustomer) === S({ customerId: 'cust-1', seenCustomerUpdatedAt: '2026-01-01' }) && !('supplierId' in cb), 'RUMPF Kunde → Lieferant');
  const p = draft(); p.supplier = { mode: 'person', person: { firstName: ' Mona ', lastName: 'Haddad', phone: '', email: '' }, createDespite: true }; p.items.push(item('a'));
  const pb = MP.buildBody(p, () => []).body;
  ok(S(pb.newSupplierPerson) === S({ firstName: 'Mona', lastName: 'Haddad', createDespiteExistingSuppliers: true }) && !('supplierId' in pb), 'RUMPF neue Person, bewusst trotz Doppelgänger');
  // Das Ausweisfoto: im Rumpf nur die Ablagekennung, nie Bytes; ohne Kennung gar nichts.
  p.supplier.person.idPhoto = { dataUrl: 'data:image/jpeg;base64,AAAA', stagingId: 'a'.repeat(64) };
  const ib = MP.buildBody(p, () => []).body;
  ok(ib.newSupplierPerson.idPhotoStagingId === 'a'.repeat(64) && !JSON.stringify(ib).includes('base64'),
    'RUMPF Ausweisfoto der neuen Person nur als Ablagekennung');
  ok(MP.supplierSummary(p) === 'New · Mona Haddad · ID photo', `ZUSAMMENFASSUNG nennt das Ausweisfoto (${MP.supplierSummary(p)})`);
  p.supplier.person.idPhoto = { dataUrl: 'data:image/jpeg;base64,AAAA' };
  ok(!('idPhotoStagingId' in MP.buildBody(p, () => []).body.newSupplierPerson), 'RUMPF ein noch nicht abgelegtes Foto reist nicht mit');
  const bad = draft();
  ok(MP.buildBody(bad, () => []).ok === false, 'RUMPF ungültiger Entwurf ergibt keinen Rumpf');
}

// ── Verdrahtung ──
{
  const seite = src('src-tauri/src/sync/mobile_page.rs');
  const ui = src('src-tauri/src/sync/mobile_purchase_ui.js');
  ok(/include_str!\("mobile_purchase_commands\.js"\)/.test(seite) && /include_str!\("mobile_purchase_ui\.js"\)/.test(seite) && /include_str!\("mobile_purchase\.html"\)/.test(seite)
    && seite.indexOf('mobile_purchase_commands.js') > seite.indexOf('mobile_repair_commands.js'), 'SEITE die drei Dateien sind eingebettet, nach dem Auftraggeber');
  ok(/'mpHome', 'formMPurchase'/.test(seite) && /mode === 'mpurchase'\) mpHomeOpen\(\)/.test(seite) && !/data-mode="purchase"/.test(seite) && !/formPurchase/.test(seite), 'SEITE eigener Modus; er ersetzt „Purchase Photo"');
  ok(/MobileRepair\.createClient\(/.test(ui) && /'purchases\.create'/.test(ui) && !/\/api\/sync\/push/.test(ui) && !/purchase_inbox\.create/.test(ui),
    'UI derselbe durable Auftraggeber, EIN Auftrag purchases.create, kein Tabellen-Push');
  ok(/indexedDB\.open\(MP_DB/.test(ui) && /stagePhoto\(p\.dataUrl\)/.test(ui) && /clarify: true/.test(ui), 'UI Entwurf samt Fotos in IndexedDB; Fotos in die Ablage; Klärung unter derselben Kennung');
  ok(/if \(\(MP\.partners \|\| \[\]\)\.length\)/.test(ui) && /Add partner/.test(ui), 'UI Partnerbereich nur bei aktiven Partnern, optional per „Add partner"');
  ok(/aiApplyToForm\(data\.result/.test(ui) && !/unitPrice[^\n]*aiApplyToForm|aiApplyToForm[^\n]*unitPrice/.test(ui), 'UI AI füllt nur Marke/Modell/Zustand/Merkmale, nie Preise');
}

console.log(`\nmobile-purchase commands: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('MOBILE_PURCHASE_COMMANDS_PROVED');
