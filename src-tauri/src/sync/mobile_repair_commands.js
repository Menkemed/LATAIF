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
  const CREATE_FIELDS = [
    'customerId', 'itemBrand', 'itemModel', 'itemReference', 'itemSerial', 'itemDescription',
    'issueDescription', 'notes', 'estimatedCost', 'estimatedReady',
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
      if (s && typeof s.keep === 'number' && s.keep >= 0) plan.push({ keep: s.keep });
      else if (s && typeof s.stagingId === 'string' && s.stagingId) plan.push({ stagingId: s.stagingId });
    }
    return plan;
  }

  /** Hat sich an den Bildern etwas geaendert? Unveraendert = der Plan ist 0,1,2,… ueber alle. */
  function photosUnchanged(plan, storedCount) {
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
    if (plan && !photosUnchanged(plan, (repair.images || []).length)) body.photos = plan;
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
    applyAiSuggestions: applyAiSuggestions,
    classify: classify,
    createClient: createClient,
  };
}));
