// PRE-G5 MOBILE CONSIGNMENT — die Befehlsseite des Telefons, ohne DOM.
//
// Dieselbe Bauweise wie `mobile_repair_commands.js`: woertlich in die Handy-Seite eingebettet und
// in node mit erfundenen Bausteinen pruefbar. Was hier steht, ist der RUMPF der Auftraege — mehr
// nicht. Gerechnet wird am Primary: Kommissionsnummer, SKU, Provision, Auszahlungsbetrag, Status,
// Fassung, Bestand und jede Buchung.
//
// Der durable Auftraggeber wird NICHT noch einmal gebaut: `MobileRepair.createClient` ist bereits
// eingebettet, kennt Kennung, Ablage, Wiederholung und Klaerung und wird hier mit einem eigenen
// Speichernamen wiederverwendet. Zwei Schreibsicherheiten waeren zwei Vertraege.
(function (root, factory) {
  const api = factory(root && root.MobileRepair);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileConsignment = api;
}(typeof self !== 'undefined' ? self : this, function (MR) {
  'use strict';

  const textOrNull = MR.textOrNull;
  const moneyOrNull = MR.moneyOrNull;
  const stableJson = MR.stableJson;

  /** Hoechstens acht Bilder — dieselbe Zahl wie `MAX_REMOTE_IMAGES` am Primary. */
  const MAX_PHOTOS = 8;

  // Die Vokabeln des Hauses, als WERTE (Lehre aus R4C.4). Der Test nagelt sie an die Quelle.
  const PAYOUT_MODELS = ['percent', 'consignor_fixed', 'cost_split'];
  const PAYOUT_METHODS = ['bank_transfer', 'cash', 'card', 'benefit'];

  /** Die Felder des Artikels, die `consignments.create` annimmt (plus `sku`). */
  const PRODUCT_TEXT_FIELDS = ['categoryId', 'brand', 'name', 'condition', 'notes', 'sku', 'storageLocation'];
  /** Was die Maske am Kopf der Kommission aendern darf (`consignments.update`). */
  const EDIT_FIELDS = ['agreedPrice', 'minimumPrice', 'expiryDate', 'notes'];
  const MONEY_FIELDS = ['agreedPrice', 'minimumPrice'];

  /**
   * Das Auszahlungsmodell samt seiner Parameter — und NUR seiner eigenen.
   *
   * Der Primary baut daraus `buildPayoutPatch`: `percent` braucht einen Satz 0–100, `cost_split`
   * einen Shop-Anteil 1–99 (0 gaebe dem Shop nichts, 100 waere `consignor_fixed` unter falschem
   * Namen), `consignor_fixed` gar keinen. Ein fremder Parameter ist hier gar nicht erst dabei —
   * `onlyKnownFields` am Primary wuerde ihn ohnehin abweisen.
   */
  function payoutPart(form) {
    const modell = textOrNull(form.payoutModel);
    if (modell === null || PAYOUT_MODELS.indexOf(modell) < 0) return { ok: false, code: 'PAYOUT_MODEL_REQUIRED' };
    const out = { model: modell };
    if (modell === 'percent') {
      const satz = moneyOrNull(form.commissionRate);
      if (satz === null || satz > 100) return { ok: false, code: 'COMMISSION_RATE_REQUIRED' };
      out.commissionRate = satz;
    } else if (modell === 'cost_split') {
      const anteil = moneyOrNull(form.excessSplitPct);
      if (anteil === null || anteil <= 0 || anteil >= 100) return { ok: false, code: 'SPLIT_REQUIRED' };
      out.excessSplitPct = anteil;
    }
    return { ok: true, payout: out };
  }

  /**
   * Der Rumpf einer Neuanlage. Eine Kommission legt IMMER auch ihren Artikel an — genau wie die
   * Maske am Rechner. `attributes` und `scopeOfDelivery` kommen aus dem Feldschema der Kategorie
   * (derselben SSOT, aus der das Anlegeformular des Telefons seine Felder baut).
   *
   * `acknowledgeDuplicate` ist die Antwort auf die Duplikatsfrage des Primary — sie reist erst mit,
   * wenn ein Mensch sie gegeben hat, nie vorsorglich.
   */
  function createBody(form, stagingIds, opts) {
    const options = opts || {};
    const einlieferer = textOrNull(form.consignorId);
    if (einlieferer === null) return { ok: false, code: 'CONSIGNOR_REQUIRED' };
    const kategorie = textOrNull(form.categoryId);
    if (kategorie === null) return { ok: false, code: 'CATEGORY_REQUIRED' };
    const preis = moneyOrNull(form.agreedPrice);
    if (preis === null || preis <= 0) return { ok: false, code: 'AGREED_PRICE_REQUIRED' };
    const modell = payoutPart(form);
    if (!modell.ok) return modell;

    const product = {};
    for (const k of PRODUCT_TEXT_FIELDS) {
      const v = textOrNull(form[k]);
      if (v !== null) product[k] = v;
    }
    if (form.attributes && Object.keys(form.attributes).length > 0) product.attributes = form.attributes;
    if (Array.isArray(form.scopeOfDelivery) && form.scopeOfDelivery.length > 0) {
      product.scopeOfDelivery = form.scopeOfDelivery.slice();
    }

    const body = { consignorId: einlieferer, product: product, agreedPrice: preis, payout: modell.payout };
    const min = moneyOrNull(form.minimumPrice);
    if (min !== null) body.minimumPrice = min;
    const ablauf = textOrNull(form.expiryDate);
    if (ablauf !== null) body.expiryDate = ablauf;
    const notiz = textOrNull(form.notes);
    if (notiz !== null) body.notes = notiz;
    const ids = (stagingIds || []).slice(0, MAX_PHOTOS);
    if (ids.length) body.stagingIds = ids;
    if (options.acknowledgeDuplicate) body.acknowledgeDuplicate = true;
    return { ok: true, body: body };
  }

  function valueOf(quelle, key) {
    return MONEY_FIELDS.indexOf(key) >= 0 ? moneyOrNull(quelle[key]) : textOrNull(quelle[key]);
  }

  /**
   * Der Rumpf einer Aenderung: nur was sich gegenueber dem GELESENEN Stand geaendert hat, dazu die
   * Fassung. Felder, die die Maske nicht zeigt, werden nicht verglichen — sonst reiste ein `null`
   * mit und leerte einen Wert, den niemand angefasst hat (der Fund aus dem Repair-Schnitt).
   *
   * Das Auszahlungsmodell reist nur mit, wenn der Primary es ueberhaupt noch erlaubt
   * (`payoutLocked` der Auskunft) UND sich etwas geaendert hat. Ist es gesperrt, ist das kein
   * Grund zu schweigen: die Maske zeigt die Sperre, und der Rumpf traegt das Modell nicht.
   */
  function editBody(con, form) {
    const body = { id: con.id, expectedRevision: con.revision };
    for (const k of EDIT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(form, k)) continue;
      const war = valueOf(con, k);
      const jetzt = valueOf(form, k);
      if (stableJson(war) !== stableJson(jetzt)) body[k] = jetzt;
    }
    if (!con.payoutLocked && Object.prototype.hasOwnProperty.call(form, 'payoutModel')) {
      const modell = payoutPart(form);
      if (!modell.ok) return modell;
      const gleich = textOrNull(con.payoutModel) === modell.payout.model
        && (modell.payout.model !== 'percent' || moneyOrNull(con.commissionRate) === modell.payout.commissionRate)
        && (modell.payout.model !== 'cost_split' || moneyOrNull(con.excessSplitPct) === modell.payout.excessSplitPct);
      if (!gleich) body.payout = modell.payout;
    }
    return { ok: true, body: body };
  }

  /** Gibt es ausser Kennung und Fassung ueberhaupt eine Aenderung? */
  function editHasChanges(body) {
    return Object.keys(body).some(function (k) { return k !== 'id' && k !== 'expectedRevision'; });
  }

  /**
   * Die Galerie des Artikels (`products.update`): behaltene Bilder mit ihrer MEDIENKENNUNG, neue
   * mit ihrer Ablagekennung. Anders als bei der Reparatur zaehlt hier keine Stelle, sondern eine
   * Identitaet — deshalb `{keep:<mediaId>}` und nie ein Index.
   */
  function galleryPlan(slots) {
    const plan = [];
    for (const s of (slots || []).slice(0, MAX_PHOTOS)) {
      if (s && typeof s.mediaId === 'string' && s.mediaId) plan.push({ keep: s.mediaId });
      else if (s && typeof s.stagingId === 'string' && s.stagingId) plan.push({ stagingId: s.stagingId });
    }
    return plan;
  }

  /** Unveraendert = genau dieselben Medienkennungen in genau derselben Reihenfolge. */
  function galleryUnchanged(plan, mediaIds) {
    const alt = mediaIds || [];
    if (plan.length !== alt.length) return false;
    return plan.every(function (p, i) { return p.keep === alt[i]; });
  }

  function galleryBody(productId, plan) {
    const id = textOrNull(productId);
    if (id === null) return { ok: false, code: 'PRODUCT_REQUIRED' };
    return { ok: true, body: { id: id, gallery: plan } };
  }

  /**
   * Ein Verkauf. Der Betrag ist der des Menschen; ob er unter dem Boden des Einlieferers liegt,
   * entscheidet der Primary (`SALE_BELOW_FLOOR`) — hier wird NICHT nachgerechnet, sonst gaebe es
   * eine zweite Abrechnung. Erst wenn er es gesagt hat, darf `acknowledgeShortfall` mitreisen.
   */
  function saleBody(con, form, opts) {
    const options = opts || {};
    const kaeufer = textOrNull(form.buyerId);
    if (kaeufer === null) return { ok: false, code: 'BUYER_REQUIRED' };
    if (kaeufer === textOrNull(con.consignorId)) return { ok: false, code: 'BUYER_IS_CONSIGNOR' };
    const preis = moneyOrNull(form.salePrice);
    if (preis === null || preis <= 0) return { ok: false, code: 'SALE_PRICE_REQUIRED' };
    const body = {
      consignmentId: con.id, expectedRevision: con.revision, buyerId: kaeufer, salePrice: preis,
      specialMark: form.specialMark === true,
    };
    const notiz = textOrNull(form.notes);
    if (notiz !== null) body.notes = notiz;
    if (options.acknowledgeShortfall) body.acknowledgeShortfall = true;
    return { ok: true, body: body };
  }

  /** Eine Auszahlung an den Einlieferer — ausdruecklich der Betrag, den die Maske gezeigt hat. */
  function payoutBody(con, form) {
    const betrag = moneyOrNull(form.amount);
    if (betrag === null || betrag <= 0) return { ok: false, code: 'AMOUNT_REQUIRED' };
    const weg = textOrNull(form.method);
    if (weg === null || PAYOUT_METHODS.indexOf(weg) < 0) return { ok: false, code: 'METHOD_REQUIRED' };
    const body = { consignmentId: con.id, expectedRevision: con.revision, amount: betrag, method: weg };
    const hinweis = textOrNull(form.reference);
    if (hinweis !== null) body.reference = hinweis;
    return { ok: true, body: body };
  }

  /** Unverkauft zurueck an den Einlieferer. */
  function returnBody(con) {
    return { ok: true, body: { consignmentId: con.id, expectedRevision: con.revision } };
  }

  /**
   * Was die AI vorschlagen darf: beschreibende Felder der WARE. Kein Preis, kein Modell, kein
   * Einlieferer, keine Nummer — die Antwort des Primary ist ohnehin gefiltert, aber ein Rumpf, der
   * es gar nicht erst anbietet, kann es auch nicht versehentlich uebernehmen.
   */
  const AI_FIELDS = ['brand', 'name', 'condition'];

  /** Nur LEERE Felder fuellen; was der Mensch getippt hat, bleibt. Gibt die Zahl zurueck. */
  function applyAiSuggestions(form, suggestion) {
    let gefuellt = 0;
    const src = (suggestion && (suggestion.fields || suggestion)) || {};
    for (const k of AI_FIELDS) {
      const v = textOrNull(src[k]);
      if (v === null) continue;
      if (textOrNull(form[k]) !== null) continue;
      form[k] = v;
      gefuellt += 1;
    }
    return gefuellt;
  }

  return {
    MAX_PHOTOS: MAX_PHOTOS,
    PAYOUT_MODELS: PAYOUT_MODELS,
    PAYOUT_METHODS: PAYOUT_METHODS,
    PRODUCT_TEXT_FIELDS: PRODUCT_TEXT_FIELDS,
    EDIT_FIELDS: EDIT_FIELDS,
    AI_FIELDS: AI_FIELDS,
    payoutPart: payoutPart,
    createBody: createBody,
    editBody: editBody,
    editHasChanges: editHasChanges,
    galleryPlan: galleryPlan,
    galleryUnchanged: galleryUnchanged,
    galleryBody: galleryBody,
    saleBody: saleBody,
    payoutBody: payoutBody,
    returnBody: returnBody,
    applyAiSuggestions: applyAiSuggestions,
  };
}));
