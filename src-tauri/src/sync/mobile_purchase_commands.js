// MOBILE-PURCHASE — die Befehlsseite des Einkaufs vom Telefon, ohne DOM.
//
// Dieselbe Bauweise wie `mobile_consignment_commands.js`: woertlich in die Handy-Seite eingebettet
// und in node mit erfundenen Bausteinen pruefbar. Hier stehen der ENTWURF (was der Mensch erfasst,
// so wie er auf dem Telefon liegt), seine Pruefung, die Zusammenfassungen der Abschnitte und der
// RUMPF von `purchases.create`. Gerechnet und gebucht wird am Primary: Belegnummer, Lose, Bestand,
// Vorsteuer, Verbindlichkeit, Zahlungen, Partneranteile, Hauptbuch.
//
// Der durable Auftraggeber wird NICHT noch einmal gebaut: `MobileRepair.createClient` (Kennung vor
// dem Senden abgelegt, Wiederholung unter derselben Kennung, Klaerung) — wie bei der Kommission.
(function (root, factory) {
  const api = factory(root && root.MobileRepair, root && root.MobileDisplayName, root && root.MobileBusinessDate);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobilePurchase = api;
}(typeof self !== 'undefined' ? self : this, function (MR, MDN, MBD) {
  'use strict';

  const textOrNull = MR.textOrNull;
  const moneyOrNull = MR.moneyOrNull;

  /** Je Position hoechstens acht Fotos — dieselbe Zahl wie `MAX_REMOTE_IMAGES` am Primary. */
  const MAX_PHOTOS = 8;
  /** Wie `MAX_DOC_LINES` am Primary. */
  const MAX_ITEMS = 100;
  const MAX_PAYMENTS = 10;
  // Die Vokabeln des Hauses als WERTE (`PURCHASE_PAYMENT_METHODS`, `PURCHASE_TAX_SCHEMES`). Der Test nagelt sie an die Quelle.
  const PAYMENT_METHODS = ['cash', 'bank', 'benefit'];
  const TAX_SCHEMES = ['ZERO', 'VAT_10'];
  const FULL_BP = 10000;
  /** Wie `isBrandRequired` am Rechner: bei Gold-Diamond Jewellery und Zubehör sind Marke und Modell freiwillig. */
  const BRAND_OPTIONAL_CATEGORIES = ['cat-gold-jewelry', 'cat-accessory'];
  function brandRequired(categoryId) { return BRAND_OPTIONAL_CATEGORIES.indexOf(String(categoryId || '')) < 0; }
  /** DISPLAY-NAME — bei Gold-Diamond Jewellery fragt die Maske nicht nach Marke/Modell (und schickt keine). */
  function brandHidden(categoryId) { return !!(MDN && MDN.brandModelHidden(categoryId)); }
  /** Der Name einer neuen Position: Marke/Modell, sonst aus den Merkmalen — wie am Rechner. */
  function newItemName(it) {
    const marke = brandHidden(it.categoryId) ? '' : it.brand;
    const modell = brandHidden(it.categoryId) ? '' : it.name;
    if (MDN) return MDN.displayName({ brand: marke, name: modell, attributes: it.attributes });
    return [textOrNull(marke), textOrNull(modell)].filter(Boolean).join(' ');
  }

  /** Fils (1/1000 BHD) — ganzzahlig, wie `F()` am Primary. */
  function F(v) { return Math.round(Number(v) * 1000); }
  function B(f) { return Math.round(f) / 1000; }
  function fmt(f) {
    const v = B(f);
    return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }

  /** Ganze Stueckzahl >= 1, sonst null. Es wird nichts gerundet oder zurechtgebogen. */
  function qtyOrNull(v) {
    const s = String(v == null ? '' : v).trim();
    if (!/^[0-9]+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }

  function newDraft(id, today) {
    return {
      id: id,
      status: 'draft',                 // draft | pending | confirmed
      createdAt: null, updatedAt: null,
      supplier: { mode: 'existing', supplierId: '', name: '', customerId: '', customerUpdatedAt: '', person: { firstName: '', lastName: '', phone: '', email: '' }, createDespite: false },
      purchaseDate: today || '',
      taxScheme: 'ZERO',
      items: [],
      payments: [],
      notes: '',
      result: null,                    // was der Primary bestaetigt hat
      lastError: '',
    };
  }

  function newItem(uid, categoryId) {
    return {
      uid: uid,
      mode: 'new',                     // new | existing
      productId: '', productLabel: '',
      categoryId: categoryId || '', brand: '', name: '', sku: '', condition: '',
      attributes: {}, scopeOfDelivery: [], itemNotes: '',
      quantity: '1', unitPrice: '',
      photos: [],                      // { id, dataUrl, stagingId? }
      partners: [],                    // { partnerId, sharePct, amount? }
      partnersOpen: false,
    };
  }

  function newPayment() { return { method: 'cash', amount: '', reference: '' }; }

  /** Die Summe einer Position in Fils — Menge × Stueckpreis, wie am Primary. */
  function lineTotalF(item) {
    const q = qtyOrNull(item.quantity);
    const p = moneyOrNull(item.unitPrice);
    if (q === null || p === null) return 0;
    return F(q * p);
  }

  function totals(draft) {
    let totalF = 0, pieces = 0;
    for (const it of draft.items) { totalF += lineTotalF(it); pieces += qtyOrNull(it.quantity) || 0; }
    let paidF = 0;
    for (const p of draft.payments) { const a = moneyOrNull(p.amount); if (a !== null) paidF += F(a); }
    return { positions: draft.items.length, pieces: pieces, totalF: totalF, paidF: paidF, openF: totalF - paidF };
  }

  /** BHD-Betrag → Anteil in Prozent, auf 0,01 % gerundet — dieselbe Regel wie am Rechner (`pctOfAmount`). */
  function pctOfAmount(amount, lineTotal) {
    const a = moneyOrNull(amount);
    if (a === null || !(lineTotal > 0)) return null;
    return Math.round((a / lineTotal) * 10000) / 100;
  }

  /**
   * Die Aufteilung einer Position wie `planLineParticipation` am Primary: Kostenanteil je Partner
   * gerundet auf Fils, LATAIF traegt den Rest. Nur fuer die Anzeige — gerechnet wird am Primary.
   */
  function shareBreakdown(item) {
    const totalF = lineTotalF(item);
    const rows = [];
    let sumBp = 0, sumCostF = 0;
    for (const p of item.partners) {
      const pct = Number(p.sharePct);
      if (!Number.isFinite(pct)) continue;
      const bp = Math.round(pct * 100);
      sumBp += bp;
      const costF = Math.round(totalF * bp / FULL_BP);
      sumCostF += costF;
      rows.push({ partnerId: p.partnerId, bp: bp, costF: costF });
    }
    // Wie am Primary: nur durch Aufrunden bei 100 % Partneranteil moeglich — der letzte Partner traegt die Differenz.
    if (rows.length && sumCostF > totalF) { rows[rows.length - 1].costF -= sumCostF - totalF; sumCostF = totalF; }
    return { rows: rows, houseBp: FULL_BP - sumBp, houseCostF: totalF - sumCostF, sumBp: sumBp };
  }

  // ── Pruefung (die verbindliche macht der Primary) ─────────────────────────────────────────
  function issue(code, message, where) { return { code: code, message: message, where: where || '' }; }

  function validate(draft, opts) {
    const o = opts || {};
    const out = [];
    const s = draft.supplier || {};
    if (s.mode === 'existing' && !textOrNull(s.supplierId)) out.push(issue('SUPPLIER_REQUIRED', 'Choose the supplier.', 'supplier'));
    if (s.mode === 'customer' && !textOrNull(s.customerId)) out.push(issue('SUPPLIER_REQUIRED', 'Choose the client who sells to us.', 'supplier'));
    if (s.mode === 'person') {
      const p = s.person || {};
      if (!textOrNull(p.firstName) && !textOrNull(p.lastName)) out.push(issue('SUPPLIER_REQUIRED', 'A new person needs a name.', 'supplier'));
    }
    // BUSINESS-DATE — dieselbe Regel wie am Primary: ein echter Tag, nicht in der Zukunft. Der Entwurf
    // traegt IMMER einen ausgeschriebenen Tag — „heute" wird beim Anlegen des Entwurfs gesetzt, nie erst
    // beim Senden.
    if (!textOrNull(draft.purchaseDate)) out.push(issue('DATE_REQUIRED', 'Enter the purchase date.', 'details'));
    else {
      const datum = MBD.businessDateIssue(draft.purchaseDate, 'Purchase date', o.nowMs);
      if (datum) out.push(issue('DATE_INVALID', datum + '.', 'details'));
    }
    if (TAX_SCHEMES.indexOf(draft.taxScheme) < 0) out.push(issue('TAX_SCHEME_INVALID', 'Choose the input VAT.', 'details'));
    if (!draft.items.length) out.push(issue('LINES_REQUIRED', 'Add at least one item.', 'items'));
    if (draft.items.length > MAX_ITEMS) out.push(issue('TOO_MANY_LINES', 'At most ' + MAX_ITEMS + ' items per purchase.', 'items'));
    draft.items.forEach(function (it, i) {
      const n = 'Item ' + (i + 1) + ': ';
      if (qtyOrNull(it.quantity) === null) out.push(issue('QTY_INVALID', n + 'quantity must be a whole number of at least 1.', 'item:' + i));
      const price = moneyOrNull(it.unitPrice);
      if (price === null) out.push(issue('PRICE_INVALID', n + 'enter the price per piece (0 or more).', 'item:' + i));
      if (it.mode === 'existing') {
        if (!textOrNull(it.productId)) out.push(issue('PRODUCT_REQUIRED', n + 'choose the existing item.', 'item:' + i));
      } else {
        if (!textOrNull(it.categoryId)) out.push(issue('CATEGORY_REQUIRED', n + 'choose a category.', 'item:' + i));
        if (brandRequired(it.categoryId) && (!textOrNull(it.brand) || !textOrNull(it.name))) out.push(issue('LINE_INVALID', n + 'brand and name are needed.', 'item:' + i));
        if (it.photos.length > MAX_PHOTOS) out.push(issue('TOO_MANY_PHOTOS', n + 'at most ' + MAX_PHOTOS + ' photos.', 'item:' + i));
        for (const f of (o.fieldErrors && o.fieldErrors[i]) || []) out.push(issue('FIELD_INVALID', n + f, 'item:' + i));
      }
      if (it.partners.length) {
        const seen = {};
        for (const p of it.partners) {
          if (!textOrNull(p.partnerId)) { out.push(issue('PARTNER_REQUIRED', n + 'choose each partner.', 'item:' + i)); continue; }
          if (seen[p.partnerId]) out.push(issue('PARTNER_DUPLICATE', n + 'the same partner appears twice.', 'item:' + i));
          seen[p.partnerId] = true;
          const pct = Number(p.sharePct);
          if (!Number.isFinite(pct) || pct <= 0 || pct > 100 || Math.abs(Math.round(pct * 100) - pct * 100) > 1e-6) {
            out.push(issue('PARTNER_SHARE_INVALID', n + 'a partner share is more than 0 % and at most 100 %, with at most two decimals.', 'item:' + i));
          }
        }
        const b = shareBreakdown(it);
        if (b.sumBp > FULL_BP) out.push(issue('PARTNER_SHARES_INVALID', n + 'partner shares add up to more than 100 %.', 'item:' + i));
      }
    });
    if (draft.payments.length > MAX_PAYMENTS) out.push(issue('TOO_MANY_PAYMENTS', 'At most ' + MAX_PAYMENTS + ' payments.', 'payments'));
    draft.payments.forEach(function (p, i) {
      const a = moneyOrNull(p.amount);
      if (a === null || F(a) <= 0) out.push(issue('PAYMENT_AMOUNT_INVALID', 'Payment ' + (i + 1) + ': enter an amount greater than zero.', 'payments'));
      if (PAYMENT_METHODS.indexOf(p.method) < 0) out.push(issue('PAYMENT_METHOD_INVALID', 'Payment ' + (i + 1) + ': choose cash, bank or benefit.', 'payments'));
    });
    const t = totals(draft);
    if (t.paidF > t.totalF) out.push(issue('PAYMENT_EXCEEDS_TOTAL', 'Payments (' + fmt(t.paidF) + ') exceed the total (' + fmt(t.totalF) + ').', 'payments'));
    return out;
  }

  // ── Der Rumpf von `purchases.create` ─────────────────────────────────────────────────────────
  /**
   * `stagingIdsFor(item)` liefert die Ablagekennungen der Fotos einer Position (Inhaltshash, vom
   * Primary gerechnet) — dieselben Bytes ergeben dieselbe Kennung, also denselben Rumpf bei jeder
   * Wiederholung. Bytes reisen nie im Auftrag.
   */
  function buildBody(draft, stagingIdsFor, opts) {
    const probleme = validate(draft, opts);
    if (probleme.length) return { ok: false, code: probleme[0].code, issues: probleme };
    const s = draft.supplier;
    const body = { purchaseDate: draft.purchaseDate, taxScheme: draft.taxScheme };
    if (s.mode === 'existing') body.supplierId = s.supplierId;
    else if (s.mode === 'customer') {
      body.supplierFromCustomer = { customerId: s.customerId, seenCustomerUpdatedAt: s.customerUpdatedAt || '' };
      if (s.createDespite) body.supplierFromCustomer.createDespiteExistingSuppliers = true;
    } else {
      const p = s.person || {};
      const person = {};
      for (const k of ['firstName', 'lastName', 'phone', 'email']) { const v = textOrNull(p[k]); if (v !== null) person[k] = v; }
      if (s.createDespite) person.createDespiteExistingSuppliers = true;
      // Das Ausweisfoto (optional) liegt schon in der Ablage des Primary — im Rumpf nur seine Kennung.
      if (p.idPhoto && p.idPhoto.stagingId) person.idPhotoStagingId = p.idPhoto.stagingId;
      body.newSupplierPerson = person;
    }
    body.lines = draft.items.map(function (it) {
      const line = {
        mode: it.mode,
        brand: it.mode === 'new' && !brandHidden(it.categoryId) ? (textOrNull(it.brand) || '') : '',
        name: it.mode === 'new' && !brandHidden(it.categoryId) ? (textOrNull(it.name) || '') : '',
        sku: it.mode === 'new' ? (textOrNull(it.sku) || '') : '',
        categoryId: it.mode === 'new' ? (textOrNull(it.categoryId) || '') : '',
        quantity: qtyOrNull(it.quantity),
        unitPrice: moneyOrNull(it.unitPrice),
      };
      if (it.mode === 'existing') line.productId = it.productId;
      else {
        const np = brandHidden(it.categoryId)
          ? { categoryId: it.categoryId, brand: null, name: null }
          : { categoryId: it.categoryId, brand: textOrNull(it.brand), name: textOrNull(it.name) };
        const sku = textOrNull(it.sku); if (sku !== null) np.sku = sku;
        const cond = textOrNull(it.condition); if (cond !== null) np.condition = cond;
        if (it.attributes && Object.keys(it.attributes).length) np.attributes = it.attributes;
        if (Array.isArray(it.scopeOfDelivery) && it.scopeOfDelivery.length) np.scopeOfDelivery = it.scopeOfDelivery.slice();
        const note = textOrNull(it.itemNotes); if (note !== null) np.notes = note;
        const ids = (stagingIdsFor ? stagingIdsFor(it) : []) || [];
        if (ids.length) np.stagingIds = ids.slice(0, MAX_PHOTOS);
        line.newProduct = np;
      }
      if (it.partners.length) line.partnerShares = it.partners.map(function (p) { return { partnerId: p.partnerId, sharePct: Number(p.sharePct) }; });
      return line;
    });
    if (draft.payments.length) {
      body.payments = draft.payments.map(function (p) {
        const out = { amount: moneyOrNull(p.amount), method: p.method };
        const ref = textOrNull(p.reference); if (ref !== null) out.reference = ref;
        return out;
      });
    }
    const notes = textOrNull(draft.notes); if (notes !== null) body.notes = notes;
    return { ok: true, body: body };
  }

  // ── Kurze Zusammenfassungen der zugeklappten Abschnitte ──────────────────────────────────────
  function supplierSummary(draft) {
    const s = draft.supplier || {};
    if (s.mode === 'person') {
      const p = s.person || {};
      const name = [textOrNull(p.firstName), textOrNull(p.lastName)].filter(Boolean).join(' ');
      return name ? 'New · ' + name + (p.idPhoto ? ' · ID photo' : '') : 'not chosen';
    }
    return textOrNull(s.name) || 'not chosen';
  }
  function itemsSummary(draft) {
    const t = totals(draft);
    if (!t.positions) return 'none yet';
    return t.positions + ' position' + (t.positions === 1 ? '' : 's') + ' · ' + t.pieces + ' pc' + (t.pieces === 1 ? '' : 's') + ' · ' + fmt(t.totalF) + ' BHD';
  }
  function itemSummary(item) {
    const name = item.mode === 'existing' ? (item.productLabel || 'existing item') : (newItemName(item) || 'new item');
    const q = qtyOrNull(item.quantity) || 0;
    return name + ' · ' + q + ' × ' + (moneyOrNull(item.unitPrice) === null ? '—' : fmt(F(moneyOrNull(item.unitPrice)))) + (item.partners.length ? ' · partner' : '');
  }
  function partnerSummary(item) {
    if (!item.partners.length) return 'LATAIF alone';
    const b = shareBreakdown(item);
    return 'Partner ' + (b.sumBp / 100) + ' % · LATAIF ' + (b.houseBp / 100) + ' %';
  }
  function paymentsSummary(draft) {
    const t = totals(draft);
    return fmt(t.paidF) + ' / ' + fmt(t.totalF) + ' BHD paid' + (t.openF > 0 ? ' · ' + fmt(t.openF) + ' open' : '');
  }
  function statusLabel(status) {
    return status === 'confirmed' ? 'Booked' : status === 'pending' ? 'Waiting for main computer' : 'Draft';
  }

  /** Was die AI vorschlagen darf: beschreibende Felder der Ware — nie Preis, Menge, Partner, Zahlung. */
  const AI_FIELDS = ['brand', 'name', 'condition'];

  return {
    MAX_PHOTOS: MAX_PHOTOS, MAX_ITEMS: MAX_ITEMS, MAX_PAYMENTS: MAX_PAYMENTS,
    PAYMENT_METHODS: PAYMENT_METHODS, TAX_SCHEMES: TAX_SCHEMES, AI_FIELDS: AI_FIELDS,
    F: F, B: B, fmt: fmt, qtyOrNull: qtyOrNull,
    newDraft: newDraft, newItem: newItem, newPayment: newPayment,
    lineTotalF: lineTotalF, totals: totals, pctOfAmount: pctOfAmount, shareBreakdown: shareBreakdown,
    validate: validate, buildBody: buildBody, brandRequired: brandRequired, brandHidden: brandHidden,
    supplierSummary: supplierSummary, itemsSummary: itemsSummary, itemSummary: itemSummary,
    partnerSummary: partnerSummary, paymentsSummary: paymentsSummary, statusLabel: statusLabel,
  };
}));
