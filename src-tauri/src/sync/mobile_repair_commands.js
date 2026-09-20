// PRE-G5 MOBILE REPAIR — die Befehlsseite des Telefons, ohne DOM.
//
// Warum eine eigene Datei: genau wie `mobile_upload_queue.js` wird sie woertlich in die
// Handy-Seite eingebettet (concat!/include_str!) UND laesst sich in node mit erfundenen
// Bausteinen pruefen (ein Speicher im Arbeitsspeicher, ein erfundenes `fetch`). Was hier steht,
// ist die einzige Stelle, an der das Telefon Auftraege stellt.
//
// Der Weg ist DERSELBE wie bei PC2: Fotos vorher nach `/api/staging/media`, danach ein Fernbefehl
// an `/api/command`. Das Telefon schreibt KEINE Zeile selbst, erfindet keine Reparaturnummer und
// kennt keine zweite Reparaturlogik — die liegt am Primary.
//
// Die Kennung eines Auftrags (`commandId`) gehoert dem VORHABEN, nicht dem Versuch: sie wird VOR
// dem ersten Senden durabel abgelegt (IndexedDB) und bei jedem Wiederholen wiederverwendet. Geht
// eine Antwort verloren, wiederholt dieselbe Kennung den Auftrag — der Primary antwortet dann aus
// seinem durablen Nachweis (Replay) statt ein zweites Mal zu buchen.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileRepair = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Hoechstens sechs Fotos je Reparatur — dieselbe Grenze wie REPAIR_MAX_PHOTOS am Primary.
  const MAX_PHOTOS = 6;

  // Genau die Felder, die `repairs.create` am Primary annimmt und die auf einem Telefon Sinn
  // haben. Alles andere (Nummer, Status, Kennungen, Filiale, Benutzer, Mandant, Marge) setzt der
  // Primary — das Telefon kann es nicht einmal senden.
  // `chargeToCustomer` gehoert dazu: die Maske fragt „Customer Pays (BHD)", der Primary nimmt es
  // beim ANLEGEN an (`parseRepairCreate`), und ohne den Betrag verweigert er spaeter zu Recht die
  // Rechnung (`REPAIR_HAS_NO_CHARGE`). Bis hierher fiel er still weg — ein Feld ohne Weg.
  const CREATE_FIELDS = [
    'customerId', 'itemBrand', 'itemModel', 'itemReference', 'itemSerial', 'itemDescription',
    'issueDescription', 'notes', 'estimatedCost', 'chargeToCustomer', 'estimatedReady',
  ];

  // Und die Felder einer Aenderung (Teilmenge von REPAIR_EDIT_INPUTS). Der Primary mischt sie
  // ueber die gelesene Zeile, deshalb aendert ein weggelassenes Feld nichts.
  const EDIT_FIELDS = [
    'diagnosis', 'estimatedCost', 'actualCost', 'chargeToCustomer', 'repairType',
    'workshopSupplierId', 'estimatedReady', 'notes', 'itemBrand', 'itemModel', 'itemReference',
    'itemSerial', 'itemDescription', 'issueDescription',
  ];

  // Was die AI vorschlagen darf — beschreibende Felder der Ware und das Problem. Kein Geld, keine
  // Kennung, kein Status, kein Kunde.
  const AI_FIELDS = [
    'itemBrand', 'itemModel', 'itemReference', 'itemSerial', 'itemDescription', 'issueDescription',
  ];

  // Geldfelder werden anders gelesen als Text — an einer Stelle festgehalten, damit Rumpfbau und
  // Vergleich nie auseinanderlaufen.
  const MONEY_FIELDS = ['estimatedCost', 'actualCost', 'chargeToCustomer'];

  // Die Vokabeln des Hauses. Sie stehen hier als WERTE, weil eine Auswahl sie anbieten und ein
  // Rumpf sie pruefen muss — dieselbe Lehre wie bei den Arbeitsarten am Rechner (R4C.4): eine
  // zweite Liste laeuft irgendwann auseinander, deshalb sind es genau die Woerter des Primary.
  const WORK_TYPES = ['service', 'polishing', 'spare_part', 'gold_work', 'stone_setting', 'engraving', 'plating', 'other'];
  // Das Vokabular des Hauses (`MATERIAL_KINDS`, gold-house.ts) — und was eine REPARATUR davon
  // annimmt: `addRepairMaterialInHouse` ruft `checkMaterialRows(..., allowLabor = false)`, also
  // weist der Primary `labor` an einer Reparatur IMMER ab (`MATERIAL_KIND_INVALID`). Der Rechner
  // bietet es dort ebenso wenig an (RepairDetail reicht kein `allowLabor`). Eine Art, die nur
  // abgewiesen werden kann, gehoert nicht in die Auswahl — das waere ein Knopf ins Leere.
  const MATERIAL_KINDS = ['labor', 'diamond', 'stone', 'gold'];
  const REPAIR_MATERIAL_KINDS = ['diamond', 'stone', 'gold'];
  const GOLD_SOURCES = ['workshop', 'customer'];
  const GOLD_LEFTOVER = ['return', 'credit', 'shop_keep'];
  const GOLD_SETTLEMENT = ['return_gold', 'pay_money'];
  const TAX_SCHEMES = ['ZERO', 'VAT_10'];
  /** „Eigene Werkstatt" — derselbe Platzhalter wie am Rechner. */
  const INHOUSE = '__INHOUSE__';

  /** Derselbe Inhalt ergibt dieselbe Zeichenkette, gleich in welcher Reihenfolge die Schluessel stehen. */
  function stableJson(v) {
    if (Array.isArray(v)) return '[' + v.map(function (x) { return stableJson(x === undefined ? null : x); }).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
        .map(function (k) { return JSON.stringify(k) + ':' + stableJson(v[k]); }).join(',') + '}';
    }
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  }

  /** Text oder nichts: ein leeres Feld reist als `null`, nie als leerer Text mit Bedeutung. */
  function textOrNull(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }

  /** Geld: nur eine echte Zahl >= 0 reist mit. Ein unlesbarer Betrag ist „nicht angegeben". */
  function moneyOrNull(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function valueOf(form, key) {
    return MONEY_FIELDS.indexOf(key) >= 0 ? moneyOrNull(form[key]) : textOrNull(form[key]);
  }

  /**
   * Wie eine Kostenzeile am Telefon HEISST. „polishing · 12.500 · OPEN" sagte nicht, was gemacht
   * wurde, von wem und woraus — dabei steht alles davon laengst in der Zeile (die Auskunft
   * `repairs.get` gibt es jetzt mit). Dieselbe Schreibweise wie am Rechner
   * (`core/repairs/repair-line-view.ts`); der Einheitstest haelt beide gegeneinander.
   */
  function wortArt(wort) {
    const t = String(wort || '').trim();
    if (!t) return '';
    return t.split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
  }

  function materialDetailText(zeile) {
    const d = (zeile && zeile.materialDetails) || {};
    const art = String((zeile && zeile.materialKind) || '');
    if (art === 'diamond' || art === 'stone') {
      const ct = Number(d.ct);
      if (!isFinite(ct) || ct <= 0) return '';
      const menge = Number(d.qty);
      return (isFinite(menge) && menge > 0 ? menge : 1) + ' × ' + ct.toFixed(2) + ' ct';
    }
    if (art === 'gold') {
      const g = Number(d.weightGrams);
      const karat = String(d.karat || '').trim();
      if (!isFinite(g) || g <= 0) return karat;
      return karat ? g.toFixed(3) + ' g · ' + karat : g.toFixed(3) + ' g';
    }
    return '';
  }

  /** Quelle · Art — Erfasstes — Text · Betrag · Stand. */
  function lineText(zeile) {
    const z = zeile || {};
    const quelle = textOrNull(z.supplierName) || (textOrNull(z.supplierId) ? 'Supplier' : 'In-house');
    const art = wortArt(z.materialKind || z.workType) || 'Other';
    const teile = [art, materialDetailText(z), textOrNull(z.description) || ''];
    const mitte = teile.filter(function (t) { return !!t; }).join(' — ');
    const betrag = Number(z.costAmount);
    return [quelle, mitte, (isFinite(betrag) ? betrag : 0).toFixed(3), String(z.status || '')]
      .filter(function (t) { return !!t; }).join(' · ');
  }

  /**
   * Die eine Zeile eines Goldeinsatzes — Wort fuer Wort wie am Rechner
   * (`core/gold/gold-usage-view.ts`); der Einheitstest haelt beide gegeneinander.
   */
  function goldGramm(v) {
    const n = Number(v);
    return isFinite(n) ? n.toFixed(3) + ' g' : '';
  }

  function goldUsageLine(h) {
    const e = h || {};
    const teile = [];
    const erhalten = goldGramm(e.receivedGrams);
    if (erhalten) teile.push('Received ' + erhalten);
    if (String(e.source || '') === 'workshop') {
      teile.push('gold debt');
      if (e.settlementType === 'pay_money') teile.push('settled in money');
      else if (e.settlementType === 'return_gold') teile.push('settled in gold');
      return teile.join(' · ');
    }
    const verbraucht = goldGramm(e.usedGrams);
    if (verbraucht) teile.push('Used ' + verbraucht);
    const rest = goldGramm(e.remainderGrams);
    if (rest) teile.push('Remainder ' + rest);
    if (Number(e.remainderGrams) > 0) {
      if (e.leftover === 'credit') teile.push('kept as customer credit');
      else if (e.leftover === 'shop_keep') teile.push('kept by the shop');
      else if (e.leftover === 'return') teile.push('back to the customer');
    }
    return teile.join(' · ');
  }

  /** Nur gesetzte Felder aus einer Erlaubnisliste — der Rumpf traegt nie ein fremdes Feld. */
  function pick(form, fields) {
    const out = {};
    for (const k of fields) {
      const v = valueOf(form, k);
      if (v !== null) out[k] = v;
    }
    return out;
  }

  /**
   * Der Rumpf einer Neuanlage. `photos` sind ausschliesslich Staging-Kennungen — Bytes reisen nie
   * in einem Befehl.
   */
  function createBody(form, stagingIds) {
    const body = pick(form, CREATE_FIELDS);
    const ids = (stagingIds || []).slice(0, MAX_PHOTOS);
    if (ids.length) body.photos = ids.map(function (id) { return { stagingId: id }; });
    return body;
  }

  /**
   * Der Bildplan einer Aenderung: die BEHALTENEN zeigen mit ihrem urspruenglichen Platz auf die
   * gespeicherte Liste (`{keep:i}`), neue tragen ihre Staging-Kennung. Die Reihenfolge ist die,
   * die der Benutzer sieht.
   */
  function photoPlan(slots) {
    const plan = [];
    for (const s of (slots || []).slice(0, MAX_PHOTOS)) {
      if (s && typeof s.keep === 'string' && s.keep) plan.push({ keep: s.keep });
      else if (s && typeof s.stagingId === 'string' && s.stagingId) plan.push({ stagingId: s.stagingId });
    }
    return plan;
  }

  /** Hat sich an den Bildern etwas geaendert? Unveraendert = der Plan ist 0,1,2,… ueber alle. */
  // MEDIA-REPAIR — unveraendert heisst: genau die gespeicherten Medien, in genau dieser Reihenfolge.
  function photosUnchanged(plan, stored) {
    var ids = Array.isArray(stored) ? stored : [];
    if (!Array.isArray(plan) || plan.length !== ids.length) return false;
    return plan.every(function (p, i) { return p && p.keep === ids[i]; });
  }
  function photosUnchangedLegacy(plan, storedCount) {
    if (plan.length !== storedCount) return false;
    return plan.every(function (p, i) { return typeof p.keep === 'number' && p.keep === i; });
  }

  /**
   * Der Rumpf einer Aenderung. Er traegt NUR, was sich gegenueber dem gelesenen Stand geaendert
   * hat — und immer die Fassung, gegen die der Benutzer gearbeitet hat. Aendert sie sich am
   * Primary, weist er die Aenderung ab (`RECORD_CHANGED`), statt eine fremde zu ueberschreiben.
   */
  function editBody(repair, form, plan) {
    const body = { id: repair.id, expectedRevision: repair.revision };
    // NUR Felder, die die Maske wirklich zeigt. Ein Feld, das es auf dem Telefon nicht gibt, kann
    // dort auch nicht geaendert worden sein — es mitzuvergleichen hiesse, den gelesenen Wert gegen
    // „nichts" zu halten und ihn zu LEEREN (`repairType: null` war genau das, und der Primary hat
    // es zu Recht abgewiesen). Der Primary mischt Aenderungen ohnehin ueber die gelesene Zeile.
    for (const k of EDIT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(form, k)) continue;
      const was = valueOf(repair, k);
      const now = valueOf(form, k);
      if (stableJson(was) !== stableJson(now)) body[k] = now;
    }
    if (plan && !photosUnchanged(plan, repair.mediaIds || [])) body.photos = plan;
    return body;
  }

  /** Gibt es ausser Kennung und Fassung ueberhaupt eine Aenderung? */
  function editHasChanges(body) {
    return Object.keys(body).some(function (k) { return k !== 'id' && k !== 'expectedRevision'; });
  }

  /**
   * Vorschlaege der AI in das Formular: NUR echte Repair-Felder, NUR leere Felder. Was der Mensch
   * getippt hat, bleibt stehen; gespeichert wird nichts. Gibt die Zahl der gefuellten Felder
   * zurueck.
   */
  function applyAiSuggestions(form, suggestion) {
    let filled = 0;
    const src = (suggestion && (suggestion.fields || suggestion)) || {};
    for (const k of AI_FIELDS) {
      const v = textOrNull(src[k]);
      if (v === null) continue;
      if (textOrNull(form[k]) !== null) continue;
      form[k] = v;
      filled += 1;
    }
    return filled;
  }

  // ── Werkstattwege: Arbeitszeile, Storno, Material, Gold, Rechnung ───────────────────────────
  //
  // Alle fuenf sind VORHANDENE Fernbefehle des Primary; hier entsteht nur ihr Rumpf. Was der
  // Primary ausrechnet oder bucht (Ausgabe, Gegenkonto, Hauptbuch, Marge, Rechnungsnummer),
  // kommt nie von hier. Jeder Rumpf traegt die GELESENE Fassung — aendert jemand anders die
  // Reparatur zwischendurch, weist der Primary ab, statt eine fremde Aenderung zu ueberschreiben.
  //
  // Die Pruefungen hier sind KEINE zweite Fachlogik: sie sagen dem Menschen vor dem Senden, was
  // fehlt. Das Urteil faellt immer der Primary.

  /** Eine Arbeitszeile (Werkstatt oder eigene Arbeit). */
  function lineBody(repair, form) {
    const kosten = moneyOrNull(form.costAmount);
    if (kosten === null || kosten <= 0) return { ok: false, code: 'COST_REQUIRED' };
    const art = textOrNull(form.workType);
    if (art !== null && WORK_TYPES.indexOf(art) < 0) return { ok: false, code: 'WORK_TYPE_INVALID' };
    const body = { repairId: repair.id, expectedRevision: repair.revision, costAmount: kosten };
    if (art !== null) body.workType = art;
    // Eigene Arbeit hat keinen Lieferanten — der Platzhalter reist NICHT mit.
    const lief = textOrNull(form.supplierId);
    if (lief !== null && lief !== INHOUSE) body.supplierId = lief;
    const text = textOrNull(form.description);
    if (text !== null) body.description = text;
    return { ok: true, body: body };
  }

  /** Eine Zeile zuruecknehmen. Der Primary loest Ausgabe, Zahlung und Buchung mit auf. */
  function cancelLineBody(repair, lineId, notes) {
    const id = textOrNull(lineId);
    if (id === null) return { ok: false, code: 'LINE_REQUIRED' };
    const body = { repairId: repair.id, expectedRevision: repair.revision, lineId: id };
    const n = textOrNull(notes);
    if (n !== null) body.notes = n;
    return { ok: true, body: body };
  }

  /**
   * Eine Materialposition. `supplierId` ist Pflicht — ein Lieferant ODER die eigene Werkstatt.
   *
   * Die Felder haengen an der ART, genau wie am Rechner (`AddMaterialModal`) und wie der Primary
   * prueft (`checkMaterialRows`): Diamant/Stein brauchen das Karat JE STUECK und tragen weder
   * Gewicht noch Karatangabe; ein Goldstueck braucht Gewicht und Karat und kein Karat je Stueck.
   * Ein Feld der falschen Art weist der Primary ab (`MATERIAL_FIELD_NOT_APPLICABLE`) — deshalb
   * reist hier nur, was zur gewaehlten Art gehoert.
   */
  function materialBody(repair, form) {
    const art = textOrNull(form.materialKind);
    if (art === null || REPAIR_MATERIAL_KINDS.indexOf(art) < 0) return { ok: false, code: 'MATERIAL_KIND_REQUIRED' };
    const text = textOrNull(form.description);
    if (text === null) return { ok: false, code: 'DESCRIPTION_REQUIRED' };
    const lief = textOrNull(form.supplierId);
    if (lief === null) return { ok: false, code: 'SUPPLIER_REQUIRED' };
    const kosten = moneyOrNull(form.totalCost);
    if (kosten === null || kosten <= 0) return { ok: false, code: 'COST_REQUIRED' };
    const zeile = { materialKind: art, description: text, supplierId: lief, totalCost: kosten };
    // Ohne Angabe rechnet der Primary mit einem Stueck; eine angegebene Menge muss > 0 sein.
    const menge = moneyOrNull(form.quantity);
    if (menge !== null) {
      if (menge <= 0) return { ok: false, code: 'QUANTITY_INVALID' };
      zeile.quantity = menge;
    }
    if (art === 'diamond' || art === 'stone') {
      const ct = moneyOrNull(form.caratPerPiece);
      if (ct === null || ct <= 0) return { ok: false, code: 'CARAT_REQUIRED' };
      zeile.caratPerPiece = ct;
    } else {
      const gramm = moneyOrNull(form.weightGrams);
      if (gramm === null || gramm <= 0) return { ok: false, code: 'WEIGHT_REQUIRED' };
      const karat = textOrNull(form.karat);
      if (karat === null) return { ok: false, code: 'KARAT_REQUIRED' };
      zeile.weightGrams = gramm;
      zeile.karat = karat;
    }
    return { ok: true, body: { repairId: repair.id, expectedRevision: repair.revision, rows: [zeile] } };
  }

  /**
   * Goldeinsatz. Zwei Faelle mit VERSCHIEDENEN Feldern — der Primary weist einen gemischten Rumpf
   * ab, deshalb wird hier genau der eine oder der andere gebaut:
   *   Werkstattgold  → wird in voller Hoehe eine Goldschuld (Lieferant, ohne Verbrauch/Rest)
   *   Kundengold     → Verbrauch und Rest (zurueck, Guthaben oder im Haus behalten), ohne Lieferant
   */
  function goldBody(repair, form) {
    const quelle = textOrNull(form.source);
    if (quelle === null || GOLD_SOURCES.indexOf(quelle) < 0) return { ok: false, code: 'SOURCE_REQUIRED' };
    const karat = textOrNull(form.karat);
    if (karat === null) return { ok: false, code: 'KARAT_REQUIRED' };
    const erhalten = moneyOrNull(form.receivedGrams);
    if (erhalten === null || erhalten <= 0) return { ok: false, code: 'RECEIVED_REQUIRED' };
    const body = {
      repairId: repair.id, expectedRevision: repair.revision,
      source: quelle, karat: karat, receivedGrams: erhalten,
    };
    if (quelle === 'workshop') {
      const lief = textOrNull(form.supplierId);
      if (lief === null || lief === INHOUSE) return { ok: false, code: 'SUPPLIER_REQUIRED' };
      body.supplierId = lief;
      const art = textOrNull(form.settlementType);
      if (art !== null) {
        if (GOLD_SETTLEMENT.indexOf(art) < 0) return { ok: false, code: 'SETTLEMENT_INVALID' };
        body.settlementType = art;
      }
    } else {
      const rest = textOrNull(form.leftover);
      if (rest === null || GOLD_LEFTOVER.indexOf(rest) < 0) return { ok: false, code: 'LEFTOVER_REQUIRED' };
      body.leftover = rest;
      const genutzt = moneyOrNull(form.usedGrams);
      if (genutzt !== null) body.usedGrams = genutzt;
    }
    return { ok: true, body: body };
  }

  /** Die Rechnung zu GENAU dieser Reparatur. Ob sie erlaubt ist, entscheidet der Primary. */
  function invoiceBody(repair, taxScheme) {
    const body = { repairId: repair.id, expectedRevision: repair.revision };
    const steuer = textOrNull(taxScheme);
    if (steuer !== null) {
      if (TAX_SCHEMES.indexOf(steuer) < 0) return { ok: false, code: 'TAX_SCHEME_INVALID' };
      body.taxScheme = steuer;
    }
    return { ok: true, body: body };
  }

  /** Was aus einer Antwort des Primary wird — dieselben Ausgaenge wie am Rechner. */
  function classify(status, body) {
    const err = (body && body.error) || '';
    if (status === 200 || status === 201) return { kind: 'ok', code: '' };
    if (status === 409 && body && body.outcome === 'not_executed') {
      return { kind: 'conflict', code: String(err || 'BRIDGE_COMMAND_ID_CONFLICT') };
    }
    if (status === 409 || status === 422 || status === 400) return { kind: 'rejected', code: String(err || 'REJECTED') };
    if (status === 401 || status === 403) return { kind: 'unauthorized', code: String(err || 'UNAUTHORIZED') };
    // 0 = kein Netz, 503 = kein Fenster am Primary, 5xx/504 = keine Antwort: ob der Auftrag lief,
    // weiss das Telefon NICHT. Er bleibt offen und behaelt seine Kennung.
    return { kind: 'unresolved', code: String(err || ('HTTP_' + status)) };
  }

  /**
   * Der Auftraggeber des Telefons.
   *
   * `store` ist ein durabler Schluessel-Wert-Speicher (IndexedDB auf dem Telefon, eine Map im
   * Test) mit `get/put/delete/getAll`. Ein Eintrag haelt Kennung, Auftrag, Rumpf und Zustand eines
   * VORHABENS — nicht eines Versuchs.
   */
  function createClient(deps) {
    const fetchFn = deps.fetchFn;
    const store = deps.store;
    const genId = deps.genId;
    const token = deps.token;
    const now = deps.now || function () { return new Date().toISOString(); };

    async function post(path, body) {
      let res;
      try {
        res = await fetchFn(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { status: 0, body: null };
      }
      let parsed = null;
      try { parsed = await res.json(); } catch (e) { parsed = null; }
      return { status: res.status, body: parsed };
    }

    /** Eine Auskunft. Sie darf jederzeit wiederholt werden, also bekommt sie jedes Mal eine neue Kennung. */
    async function read(op, input) {
      const r = await post('/api/command', { op: op, commandId: genId(), payload: input || {} });
      if (r.status === 200) return { ok: true, value: (r.body && r.body.value) || null };
      return { ok: false, status: r.status, code: (r.body && r.body.error) || ('HTTP_' + r.status) };
    }

    /** Ein Foto in die Ablage des Primary. Die Kennung ist der Hash der Bytes — er rechnet ihn. */
    async function stagePhoto(dataUrl) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''));
      if (!m) return { ok: false, code: 'NOT_A_PHOTO' };
      const r = await post('/api/staging/media', { mime: m[1], dataBase64: m[2] });
      if (r.status === 201 && r.body && r.body.stagingId) return { ok: true, stagingId: r.body.stagingId };
      return { ok: false, code: (r.body && (r.body.code || r.body.error)) || ('HTTP_' + r.status) };
    }

    /**
     * Ein Auftrag unter der Kennung SEINES Vorhabens.
     *
     * Vor dem ersten Senden wird der Eintrag geschrieben; scheitert das, geht nichts hinaus (ein
     * Auftrag, dessen Kennung ein Absturz verlieren kann, darf nicht abgeschickt werden). Ein
     * offener Eintrag mit ANDEREM Rumpf wird NICHT gesendet: erst klaeren (`clarify`, wiederholt
     * den urspruenglichen Rumpf unter seiner Kennung), dann aendern oder neu erfassen.
     */
    async function mutate(intentKey, op, payload, opts) {
      const options = opts || {};
      let rec = null;
      try { rec = await store.get(intentKey); } catch (e) { rec = null; }

      const open = rec && rec.state && rec.state !== 'ok';
      if (open && !options.clarify && stableJson(rec.payload) !== stableJson(payload)) {
        return { kind: 'changed_while_open', code: 'ORIGINAL_UNRESOLVED', record: rec };
      }
      const entry = {
        key: intentKey,
        commandId: (rec && rec.commandId) || genId(),
        op: (rec && rec.op) || op,
        // Geklaert wird IMMER der urspruengliche Auftrag — nie der neue Rumpf unter alter Kennung.
        payload: options.clarify && rec ? rec.payload : payload,
        state: 'sending',
        createdAt: (rec && rec.createdAt) || now(),
        updatedAt: now(),
      };
      try {
        await store.put(entry);
      } catch (e) {
        return { kind: 'not_sent', code: 'PENDING_STORE_FAILED' };
      }

      const r = await post('/api/command', { op: entry.op, commandId: entry.commandId, payload: entry.payload });
      const out = classify(r.status, r.body);
      if (out.kind === 'ok' || out.kind === 'rejected') {
        try { await store.delete(intentKey); } catch (e) { /* der naechste Start raeumt auf */ }
      } else {
        try {
          await store.put({ key: entry.key, commandId: entry.commandId, op: entry.op, payload: entry.payload, state: out.kind, lastCode: out.code, createdAt: entry.createdAt, updatedAt: now() });
        } catch (e) { /* offen bleibt offen */ }
      }
      return {
        kind: out.kind,
        code: out.code,
        // Der Primary begruendet eine Ablehnung in Worten (Duplikatstreffer, Fehlbetrag). Wer sie
        // verschweigt, laesst den Menschen mit einem Code allein.
        message: (r.body && r.body.message) || '',
        value: (r.body && r.body.value) || null,
        status: r.status,
        commandId: entry.commandId,
      };
    }

    /** Die offenen Vorhaben dieses Telefons — was die Leiste zeigt. */
    async function openIntents() {
      try {
        const all = await store.getAll();
        return (all || []).filter(function (e) { return e && e.state && e.state !== 'ok'; });
      } catch (e) { return []; }
    }

    return { read: read, stagePhoto: stagePhoto, mutate: mutate, openIntents: openIntents };
  }

  return {
    MAX_PHOTOS: MAX_PHOTOS,
    CREATE_FIELDS: CREATE_FIELDS,
    EDIT_FIELDS: EDIT_FIELDS,
    AI_FIELDS: AI_FIELDS,
    MONEY_FIELDS: MONEY_FIELDS,
    stableJson: stableJson,
    textOrNull: textOrNull,
    moneyOrNull: moneyOrNull,
    createBody: createBody,
    photoPlan: photoPlan,
    photosUnchanged: photosUnchanged,
    editBody: editBody,
    editHasChanges: editHasChanges,
    WORK_TYPES: WORK_TYPES,
    MATERIAL_KINDS: MATERIAL_KINDS,
    REPAIR_MATERIAL_KINDS: REPAIR_MATERIAL_KINDS,
    GOLD_SOURCES: GOLD_SOURCES,
    GOLD_LEFTOVER: GOLD_LEFTOVER,
    GOLD_SETTLEMENT: GOLD_SETTLEMENT,
    TAX_SCHEMES: TAX_SCHEMES,
    INHOUSE: INHOUSE,
    lineText: lineText,
    materialDetailText: materialDetailText,
    goldUsageLine: goldUsageLine,
    lineBody: lineBody,
    cancelLineBody: cancelLineBody,
    materialBody: materialBody,
    goldBody: goldBody,
    invoiceBody: invoiceBody,
    applyAiSuggestions: applyAiSuggestions,
    classify: classify,
    createClient: createClient,
  };
}));
