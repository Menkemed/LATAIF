  // ══ PRE-G5 MOBILE CONSIGNMENT — die Oberflaeche ══════════════════════════════════════════════
  //
  // Woertlich in die Seiten-IIFE eingebettet; sie benutzt deren Helfer ($, screen, el, uuid,
  // resizePhoto, TOKEN_KEY, idbReq) UND die vorhandenen Feld-Bausteine des Anlegeformulars
  // (SCHEMA, catById, makeControl, applyDependencies, dependsSatisfied, readAttr, aiApplyToForm).
  // Die Kategorie-Merkmale kommen damit aus DERSELBEN SSOT wie am Rechner — es gibt keine zweite
  // Feldliste und keinen zweiten AI-Weg.
  //
  // Geschrieben wird ausschliesslich ueber vorhandene Fernbefehle:
  //   consignments.create / update / record_sale / record_payout / mark_returned
  //   products.update (nur die Galerie), customers.create (neuer Einlieferer/Kaeufer)
  // Nummer, SKU, Provision, Auszahlungsbetrag, Status, Bestand und jede Buchung macht der Primary.

  const CN_DB = 'lataif_mobile_consignment', CN_STORE = 'consignIntents';
  function cnIdbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(CN_DB, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CN_STORE)) db.createObjectStore(CN_STORE, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  const cnStore = {
    async get(k) { const db = await cnIdbOpen(); return idbReq(db.transaction(CN_STORE, 'readonly').objectStore(CN_STORE).get(k)); },
    async put(e) { const db = await cnIdbOpen(); return idbReq(db.transaction(CN_STORE, 'readwrite').objectStore(CN_STORE).put(e)); },
    async delete(k) { const db = await cnIdbOpen(); return idbReq(db.transaction(CN_STORE, 'readwrite').objectStore(CN_STORE).delete(k)); },
    async getAll() { const db = await cnIdbOpen(); return idbReq(db.transaction(CN_STORE, 'readonly').objectStore(CN_STORE).getAll()); },
  };
  // DERSELBE Auftraggeber wie bei den Reparaturen: durable Kennung vor dem Senden, Wiederholung
  // unter derselben Kennung, Klaerung offener Vorgaenge. Nur die Ablage ist eine eigene.
  const cnClient = MobileRepair.createClient({
    fetchFn: (u, o) => fetch(u, o),
    store: cnStore,
    genId: uuid,
    token: () => localStorage.getItem(TOKEN_KEY) || '',
  });

  /** Kopffelder der Vereinbarung — von Lesen und Schreiben gemeinsam benutzt. */
  const CN_INPUTS = {
    agreedPrice: 'cnAgreedPrice', minimumPrice: 'cnMinimumPrice', expiryDate: 'cnExpiryDate', notes: 'cnNotes',
  };
  /** Die drei Verkaufsvorstellungen am Artikel — in der Reihenfolge des Vertrags. */
  const CN_PRICE_FIELDS = ['plannedSalePrice', 'minSalePrice', 'maxSalePrice'];
  const CN_PRICE_INPUTS = ['cnPlannedSalePrice', 'cnMinSalePrice', 'cnMaxSalePrice'];
  const CN_ATTR_PREFIX = 'cna_';
  const CN = {
    mode: 'create', con: null, product: null, slots: [], consignor: null, buyer: null,
    draftKey: null, busy: false, scope: new Set(), werkKeys: {},
  };

  function cnSay(id, text, good) {
    const e = $(id);
    if (!e) { try { console.error('[consign] message target missing: ' + id + ' — ' + text); } catch (x) { /* egal */ } return; }
    e.textContent = text || '';
    e.classList.toggle('hidden', !text);
    // Dieselbe Lehre wie bei den Reparaturen: der Knopf steht unten, die Meldung oben.
    if (text && typeof e.scrollIntoView === 'function') {
      try { e.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (x) { /* aeltere Form */ }
    }
    if (good !== undefined && (id === 'cnAiMsg' || id === 'cnActionMsg')) e.style.color = good ? '#7FA87F' : '#AA6E6E';
  }
  function cnClearMsgs() { cnSay('cnError', ''); cnSay('cnSuccess', ''); cnSay('cnAiMsg', ''); cnSay('cnActionMsg', ''); }

  function cnFuelle(id, werte, leer) {
    const sel = $(id);
    if (!sel) return;
    sel.innerHTML = '';
    if (leer !== undefined) sel.appendChild(el('option', { value: '' }, leer));
    werte.forEach((w) => sel.appendChild(el('option', { value: w.wert }, w.text)));
  }
  const CN_WORT = (w) => String(w).replace(/_/g, ' ');

  // ── Kategorie und Merkmale: dieselben Bausteine wie das Anlegeformular ───────────────────────
  function cnRenderFields(catId) {
    const cat = catById(catId);
    CN.scope.clear();
    const pflicht = cat ? !!cat.brandRequired : false;
    $('cnBrandLabel').innerHTML = 'Brand' + (pflicht ? ' <span class="req">*</span>' : '');
    $('cnNameLabel').innerHTML = 'Model / Name' + (pflicht ? ' <span class="req">*</span>' : '');
    const cs = $('cnCondition');
    cs.innerHTML = '';
    cs.appendChild(el('option', { value: '' }, '— Select —'));
    for (const o of (cat ? cat.conditionOptions : [])) cs.appendChild(el('option', { value: o }, o));
    const host = $('cnAttrs');
    host.innerHTML = '';
    if (cat) {
      for (const a of cat.attributes) {
        const row = el('div', { class: 'row', id: 'cnrow_' + a.key });
        const lbl = el('label');
        lbl.innerHTML = a.label + (a.unit ? ' (' + a.unit + ')' : '') + (a.required ? ' <span class="req">*</span>' : '');
        row.appendChild(lbl);
        row.appendChild(makeControl(a, CN_ATTR_PREFIX));
        host.appendChild(row);
      }
      for (const a of cat.attributes) {
        if (!a.dependsOn) continue;
        const dep = $(CN_ATTR_PREFIX + a.dependsOn.key);
        if (dep && dep.tagName === 'SELECT') dep.addEventListener('change', () => applyDependencies(cat, CN_ATTR_PREFIX));
      }
    }
    applyDependencies(cat || { attributes: [] }, CN_ATTR_PREFIX);
    const scopeRow = $('cnScopeRow'), scopeHost = $('cnScope');
    scopeHost.innerHTML = '';
    if (cat && cat.scopeOptions.length) {
      scopeRow.classList.remove('hidden');
      for (const o of cat.scopeOptions) {
        const b = el('button', { type: 'button', class: 'chip' }, o);
        b.onclick = () => {
          if (CN.scope.has(o)) { CN.scope.delete(o); b.classList.remove('on'); } else { CN.scope.add(o); b.classList.add('on'); }
        };
        scopeHost.appendChild(b);
      }
    } else { scopeRow.classList.add('hidden'); }
  }

  /** Die Merkmale der GEWAEHLTEN Kategorie, gelesen mit denselben Regeln wie im Anlegeformular. */
  function cnReadAttributes() {
    const cat = catById($('cnCategory').value);
    const attributes = {}, fehler = [];
    if (!cat) return { attributes: attributes, fehler: fehler };
    if (cat.brandRequired) {
      if (!$('cnBrand').value.trim()) fehler.push('Brand is required.');
      if (!$('cnName').value.trim()) fehler.push('Model / Name is required.');
    }
    for (const a of cat.attributes) {
      if (!dependsSatisfied(a, CN_ATTR_PREFIX)) continue;   // verdeckte Felder reisen nie mit
      const v = readAttr(a, CN_ATTR_PREFIX);
      if (a.type === 'number' && Number.isNaN(v)) { fehler.push(a.label + ' must be a valid number ≥ 0.'); continue; }
      const leer = v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0);
      if (leer) { if (a.required) fehler.push(a.label + ' is required.'); continue; }
      attributes[a.key] = v;
    }
    return { attributes: attributes, fehler: fehler };
  }

  // ── Fotos ───────────────────────────────────────────────────────────────────────────────────
  function cnRenderPhotos() {
    const strip = $('cnPhotoStrip'), area = $('cnPhotoArea'), hint = $('cnPhotoHint'), status = $('cnPhotoStatus');
    strip.innerHTML = '';
    const hat = CN.slots.length > 0;
    strip.classList.toggle('hidden', !hat);
    hint.classList.toggle('hidden', !hat);
    status.classList.toggle('hidden', !hat);
    if (hat) status.textContent = CN.slots.length + ' / ' + MobileConsignment.MAX_PHOTOS;
    area.innerHTML = hat
      ? '<div class="icon">📷</div><div>Add more photos</div><div class="hint">' + CN.slots.length + ' of ' + MobileConsignment.MAX_PHOTOS + '</div>'
      : '<div class="icon">📷</div><div>Tap to take photos</div><div class="hint">the item as handed in — up to 8</div>';
    CN.slots.forEach((slot, i) => {
      const t = el('div', { class: 'photo-thumb' + (i === 0 ? ' is-primary' : '') });
      const im = el('img');
      im.src = slot.src || slot.dataUrl;
      t.appendChild(im);
      if (i === 0) t.appendChild(el('div', { class: 'cover' }, 'FIRST'));
      const rm = el('button', { type: 'button', class: 'rm' }, '✕');
      rm.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); CN.slots.splice(i, 1); cnRenderPhotos(); };
      t.appendChild(rm);
      t.onclick = () => { if (i === 0) return; const [p] = CN.slots.splice(i, 1); CN.slots.unshift(p); cnRenderPhotos(); };
      strip.appendChild(t);
    });
    $('cnAiBtn').classList.toggle('hidden', !hat);
    // „Save photo changes" gibt es nur an einer bestehenden Kommission und nur, wenn sich die
    // Galerie wirklich unterscheidet — sonst waere es ein Knopf, der nichts tut.
    const plan = MobileConsignment.galleryPlan(CN.slots);
    const gleich = MobileConsignment.galleryUnchanged(plan, (CN.product && CN.product.mediaIds) || []);
    $('cnGallerySaveBtn').classList.toggle('hidden', CN.mode !== 'edit' || !CN.product || gleich);
  }
  $('cnPhotoInput').onchange = async (e) => {
    const files = Array.from((e.target && e.target.files) || []);
    if (!files.length) return;
    let abgelehnt = 0;
    for (const f of files) {
      if (CN.slots.length >= MobileConsignment.MAX_PHOTOS) { abgelehnt += 1; continue; }
      try {
        const dataUrl = await resizePhoto(f, 1600, 0.85);
        CN.slots.push({ dataUrl: dataUrl, src: dataUrl });
      } catch (err) { abgelehnt += 1; }
    }
    $('cnPhotoInput').value = '';
    cnRenderPhotos();
    if (abgelehnt) cnSay('cnError', abgelehnt + ' photo(s) not added — at most ' + MobileConsignment.MAX_PHOTOS + ' per item.');
  };

  /** Neue Fotos in die Ablage des Primary; gespeicherte bleiben unberuehrt. */
  async function cnStageSlots() {
    for (const slot of CN.slots) {
      if (slot.stagingId || slot.mediaId) continue;
      const r = await cnClient.stagePhoto(slot.dataUrl);
      if (!r.ok) return { ok: false, code: r.code };
      slot.stagingId = r.stagingId;
    }
    return { ok: true };
  }

  // ── Antworten in Worte ──────────────────────────────────────────────────────────────────────
  const CN_GRUND = {
    CONSIGNOR_REQUIRED: 'Please choose or create the consignor.',
    CATEGORY_REQUIRED: 'Please choose a category.',
    AGREED_PRICE_REQUIRED: 'Please enter the agreed price (greater than zero).',
    PAYOUT_MODEL_REQUIRED: 'Please choose a payout model.',
    COMMISSION_RATE_REQUIRED: 'Please enter a commission rate between 0 and 100.',
    SPLIT_REQUIRED: "Please enter the shop's share between 1 and 99 percent.",
    BUYER_REQUIRED: 'Please choose the buyer.',
    BUYER_IS_CONSIGNOR: 'The buyer cannot be the consignor — that would be a return, not a sale.',
    SALE_PRICE_REQUIRED: 'Please enter the sale price (greater than zero).',
    AMOUNT_REQUIRED: 'Please enter an amount greater than zero.',
    METHOD_REQUIRED: 'Please choose how the consignor is paid.',
    PRODUCT_REQUIRED: 'This consignment has no item loaded.',
  };
  function cnMessageFor(r, was) {
    if (r.kind === 'rejected') return was + ': ' + (r.code || 'refused by the main computer') + '.';
    if (r.kind === 'conflict') {
      return 'The main computer holds this save number for different content. Open "Unresolved saves" '
        + 'and clarify it there — do not enter it twice.';
    }
    if (r.kind === 'changed_while_open') {
      return 'An earlier save of this is still open and your changes were NOT sent. Clarify it under '
        + '"Unresolved saves" first, then save your change.';
    }
    if (r.kind === 'not_sent') return 'Nothing was sent — this phone could not store the save number.';
    if (r.kind === 'unauthorized') return 'Your session ended. Please sign in again.';
    return 'No answer from the main computer — it MAY have been saved. It stays under "Unresolved saves"; '
      + 'clarify it there before entering it again.';
  }

  // ── Offene Vorhaben ─────────────────────────────────────────────────────────────────────────
  async function cnRenderOpen() {
    const list = await cnClient.openIntents();
    const box = $('cnOpenBox'), ul = $('cnOpenList');
    ul.innerHTML = '';
    box.classList.toggle('hidden', list.length === 0);
    list.forEach((rec) => {
      const line = el('div', { class: 'row' });
      line.appendChild(el('div', { class: 'hint' }, rec.op + ' · ' + rec.state + (rec.lastCode ? ' · ' + rec.lastCode : '')));
      const b = el('button', { type: 'button', class: 'secondary' }, 'Clarify now');
      b.onclick = async () => {
        b.disabled = true;
        const r = await cnClient.mutate(rec.key, rec.op, rec.payload, { clarify: true });
        b.disabled = false;
        cnSay('cnHomeError', r.kind === 'ok' ? '' : cnMessageFor(r, 'Still not settled'));
        await cnRenderOpen();
        await cnLoadList($('cnSearch').value);
      };
      line.appendChild(b);
      ul.appendChild(line);
    });
  }

  // ── Liste ───────────────────────────────────────────────────────────────────────────────────
  async function cnLoadList(q) {
    const box = $('cnList');
    box.innerHTML = '';
    const r = await cnClient.read('consignments.list', { q: q || '', limit: 25 });
    if (!r.ok) {
      cnSay('cnHomeError', r.status === 503
        ? 'The main computer is not answering right now (is LATAIF open on it?).'
        : 'Could not load consignments (' + r.code + ').');
      return;
    }
    cnSay('cnHomeError', '');
    const items = (r.value && r.value.items) || [];
    if (!items.length) { box.appendChild(el('div', { class: 'hint' }, 'No consignments found.')); return; }
    items.forEach((it) => {
      const card = el('div', { class: 'card' });
      const b = el('button', { type: 'button', class: 'secondary' },
        it.consignmentNumber + ' · ' + it.agreedPrice + ' · ' + it.status);
      b.onclick = () => cnOpen(it.id);
      card.appendChild(b);
      box.appendChild(card);
    });
  }

  // ── Eine Kommission oeffnen ─────────────────────────────────────────────────────────────────
  //
  // `keepForm`: nach einer Handlung wird neu gelesen — was getippt und nicht gespeichert ist,
  // bleibt stehen (dieselbe Regel wie bei den Reparaturen und am Rechner).
  async function cnOpen(id, opts) {
    const options = opts || {};
    if (!options.keepMsgs) cnClearMsgs();
    const vorher = CN.con;
    const getippt = (options.keepForm && vorher) ? cnFormValues() : null;
    const neueFotos = options.keepForm ? CN.slots.filter((s) => !s.mediaId) : [];

    const r = await cnClient.read('consignments.get', { id: id });
    if (!r.ok) { cnSay('cnHomeError', 'Could not open the consignment (' + r.code + ').'); return; }
    const con = r.value || {};
    CN.mode = 'edit';
    CN.con = con;
    CN.consignor = null;
    CN.product = null;

    // Der Artikel dazu: seine Felder und seine Galerie (Bytes holt der Browser ueber `/api/media`).
    if (con.productId) {
      const p = await cnClient.read('products.get', { id: con.productId });
      if (p.ok) CN.product = p.value || null;
    }
    cnFillForm(con);
    cnFillProduct(CN.product);
    if (getippt) {
      let offen = 0;
      for (const k in CN_INPUTS) {
        const alt = (vorher[k] === null || vorher[k] === undefined) ? '' : String(vorher[k]);
        if (getippt[k] !== alt) { $(CN_INPUTS[k]).value = getippt[k]; offen += 1; }
      }
      for (const foto of neueFotos) {
        if (CN.slots.length < MobileConsignment.MAX_PHOTOS) { CN.slots.push(foto); offen += 1; }
      }
      if (offen) cnSay('cnSuccess', 'Your unsaved entries are still here — press "Save Changes" to store them.');
    }
    $('cnHeadline').textContent = con.consignmentNumber || 'Consignment';
    $('cnSubline').textContent = (CN.product ? ((CN.product.brand || '') + ' ' + (CN.product.name || '')).trim() : '') || 'Consigned item';
    $('cnConsignorCard').classList.add('hidden');
    $('cnItemCard').classList.add('hidden');       // die Ware selbst wird am Rechner geaendert
    $('cnDuplicateCard').classList.add('hidden');
    $('cnSaveBtn').textContent = 'Save Changes';
    cnRenderState(con);
    cnRenderPhotos();
    await cnLadeAuswahlen();
    screen('formConsign');
  }

  function cnFormValues() {
    const f = {};
    for (const k in CN_INPUTS) f[k] = $(CN_INPUTS[k]).value;
    return f;
  }
  function cnFillForm(con) {
    for (const k in CN_INPUTS) {
      const v = con ? con[k] : null;
      $(CN_INPUTS[k]).value = (v === null || v === undefined) ? '' : String(v);
    }
    $('cnPayoutModel').value = (con && con.payoutModel) || 'percent';
    $('cnCommissionRate').value = con && con.commissionRate !== undefined && con.commissionRate !== null ? String(con.commissionRate) : '';
    $('cnExcessSplitPct').value = con && con.excessSplitPct !== undefined && con.excessSplitPct !== null ? String(con.excessSplitPct) : '';
    cnPayoutFelder();
    // Die Sperre entscheidet der Primary (`payoutLocked` kommt aus `payoutModelLock`), nicht eine
    // Nachbildung hier. Gesperrt heisst: sichtbar, aber nicht aenderbar.
    const gesperrt = !!(con && con.payoutLocked);
    for (const id of ['cnPayoutModel', 'cnCommissionRate', 'cnExcessSplitPct']) $(id).disabled = gesperrt;
    const msg = $('cnPayoutLockMsg');
    msg.textContent = gesperrt ? 'The payout model can no longer be changed — amounts are already booked.' : '';
    msg.classList.toggle('hidden', !gesperrt);
  }
  function cnFillProduct(p) {
    CN.slots = [];
    if (p && Array.isArray(p.mediaKeys)) {
      p.mediaKeys.forEach((key, i) => {
        CN.slots.push({ mediaId: (p.mediaIds || [])[i], src: '/api/media?key=' + encodeURIComponent(key) });
      });
    }
  }

  function cnRenderState(con) {
    $('cnStateCard').classList.remove('hidden');
    $('cnActionsCard').classList.remove('hidden');
    $('cnStateBadge').textContent = con.status || '';
    const zeilen = [
      'Agreed ' + (con.agreedPrice !== null && con.agreedPrice !== undefined ? con.agreedPrice : '—'),
      'Payout model ' + CN_WORT(con.payoutModel || ''),
      con.salePrice ? ('Sold for ' + con.salePrice) : 'Not sold yet',
      con.payoutAmount !== null && con.payoutAmount !== undefined
        ? ('Payout ' + con.payoutAmount + ' · paid ' + (con.payoutPaidAmount || 0) + ' · open ' + (con.payoutOpenAmount || 0))
        : 'No payout calculated yet',
      con.invoiceId ? 'Invoiced' : '',
    ].filter(Boolean);
    $('cnStateLines').textContent = zeilen.join(' · ');
    // Was der Primary nicht mehr annimmt, bietet die Maske nicht an: ein verkaufter Artikel wird
    // nicht noch einmal verkauft, ein zurueckgegebener nicht ausgezahlt.
    const verkauft = !!con.salePrice || con.status === 'sold';
    const beendet = con.status === 'returned' || con.status === 'cancelled';
    $('cnSaleRow').classList.toggle('hidden', verkauft || beendet);
    $('cnSaleBtn').classList.toggle('hidden', verkauft || beendet);
    const offenerRest = Number(con.payoutOpenAmount || 0) > 0;
    $('cnPayoutRow').classList.toggle('hidden', !offenerRest);
    $('cnPayoutBtn').classList.toggle('hidden', !offenerRest);
    $('cnReturnBtn').classList.toggle('hidden', verkauft || beendet);
    if (offenerRest && !$('cnPayoutAmount').value) $('cnPayoutAmount').value = String(con.payoutOpenAmount);
  }

  /** Welche Felder ein Auszahlungsmodell braucht — dieselbe Weiche wie `payoutFieldsFor`. */
  function cnPayoutFelder() {
    const m = $('cnPayoutModel').value;
    $('cnCommissionRate').classList.toggle('hidden', m !== 'percent');
    $('cnExcessSplitPct').classList.toggle('hidden', m !== 'cost_split');
  }
  $('cnPayoutModel').onchange = cnPayoutFelder;

  // ── Einlieferer und Kaeufer ─────────────────────────────────────────────────────────────────
  function cnSetConsignor(id, name) {
    CN.consignor = id ? { id: id, name: name || id } : null;
    const badge = $('cnConsignorPicked');
    badge.textContent = CN.consignor ? CN.consignor.name : '';
    badge.classList.toggle('hidden', !CN.consignor);
  }
  function cnSetBuyer(id, name) {
    CN.buyer = id ? { id: id, name: name || id } : null;
    const badge = $('cnBuyerPicked');
    badge.textContent = CN.buyer ? CN.buyer.name : '';
    badge.classList.toggle('hidden', !CN.buyer);
  }
  async function cnSucheKunden(feldId, boxId, waehle) {
    const box = $(boxId);
    box.innerHTML = '';
    const r = await cnClient.read('customers.list', { q: $(feldId).value, limit: 10 });
    if (!r.ok) { cnSay('cnError', 'Client search failed (' + r.code + ')'); return; }
    const items = (r.value && r.value.items) || [];
    if (!items.length) { box.appendChild(el('div', { class: 'hint' }, 'No client found.')); return; }
    items.forEach((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || c.id;
      const b = el('button', { type: 'button', class: 'secondary' }, name + (c.phone ? ' · ' + c.phone : ''));
      b.onclick = () => { waehle(c.id, name); box.innerHTML = ''; };
      box.appendChild(b);
    });
  }
  $('cnConsignorSearchBtn').onclick = () => cnSucheKunden('cnConsignorSearch', 'cnConsignorResults', cnSetConsignor);
  $('cnBuyerSearchBtn').onclick = () => cnSucheKunden('cnBuyerSearch', 'cnBuyerResults', cnSetBuyer);
  $('cnConsignorCreateBtn').onclick = async () => {
    const first = $('cnConsignorFirst').value.trim(), last = $('cnConsignorLast').value.trim();
    if (!first && !last) { cnSay('cnError', 'A new client needs a name.'); return; }
    const body = { firstName: first, lastName: last };
    const phone = MobileRepair.textOrNull($('cnConsignorPhone').value);
    if (phone) body.phone = phone;
    const r = await cnClient.mutate('consignor:' + (CN.draftKey || 'draft'), 'customers.create', body);
    if (r.kind === 'ok' && r.value && r.value.customerId) {
      cnSetConsignor(r.value.customerId, r.value.name || (first + ' ' + last).trim());
      cnSay('cnSuccess', 'Client created.');
      $('cnConsignorFirst').value = ''; $('cnConsignorLast').value = ''; $('cnConsignorPhone').value = '';
    } else {
      cnSay('cnError', cnMessageFor(r, 'The client was not created'));
    }
  };

  // ── Auswahlen fuellen ───────────────────────────────────────────────────────────────────────
  async function cnLadeAuswahlen() {
    cnFuelle('cnPayoutMethod', MobileConsignment.PAYOUT_METHODS.map((w) => ({ wert: w, text: CN_WORT(w) })), 'How is the consignor paid…');
    cnFuelle('cnSpecialMark', [{ wert: '', text: 'Normal invoice number' }, { wert: 'special', text: 'Special number series' }], undefined);
  }

  function cnSteuerAuswahl() {
    cnFuelle('cnTaxScheme', MobileConsignment.TAX_SCHEMES.map((w) => ({ wert: w, text: CN_WORT(w) })), 'As the house decides…');
  }

  function cnPayoutModellAuswahl() {
    cnFuelle('cnPayoutModel', MobileConsignment.PAYOUT_MODELS.map((w) => ({
      wert: w,
      text: w === 'percent' ? 'Commission percentage'
        : (w === 'consignor_fixed' ? 'Consignor gets the agreed price' : 'Split above our cost'),
    })), undefined);
  }

  // ── Neu erfassen ────────────────────────────────────────────────────────────────────────────
  function cnNewIntake() {
    cnClearMsgs();
    CN.mode = 'create';
    CN.con = null;
    CN.product = null;
    CN.slots = [];
    CN.draftKey = uuid();
    CN.buyer = null;
    cnSetConsignor(null, '');
    for (const k in CN_INPUTS) $(CN_INPUTS[k]).value = '';
    $('cnSku').value = ''; $('cnBrand').value = ''; $('cnName').value = '';
    $('cnTaxScheme').value = ''; $('cnItemNotes').value = '';
    for (const id of CN_PRICE_INPUTS) $(id).value = '';
    $('cnPayoutModel').value = 'percent';
    $('cnCommissionRate').value = ''; $('cnExcessSplitPct').value = '';
    for (const id of ['cnPayoutModel', 'cnCommissionRate', 'cnExcessSplitPct']) $(id).disabled = false;
    cnSay('cnPayoutLockMsg', '');
    $('cnPayoutLockMsg').classList.add('hidden');
    cnPayoutFelder();
    cnRenderFields($('cnCategory').value);
    $('cnHeadline').textContent = 'New Consignment Intake';
    $('cnSubline').textContent = 'An item left with us to sell';
    $('cnConsignorCard').classList.remove('hidden');
    $('cnConsignorResults').innerHTML = '';
    $('cnItemCard').classList.remove('hidden');
    $('cnStateCard').classList.add('hidden');
    $('cnActionsCard').classList.add('hidden');
    $('cnDuplicateCard').classList.add('hidden');
    $('cnSaveBtn').textContent = 'Save Consignment';
    cnRenderPhotos();
    screen('formConsign');
  }

  // ── Speichern ───────────────────────────────────────────────────────────────────────────────
  function cnCreateForm() {
    const merkmale = cnReadAttributes();
    const form = {
      consignorId: CN.consignor ? CN.consignor.id : '',
      categoryId: $('cnCategory').value,
      brand: $('cnBrand').value, name: $('cnName').value,
      condition: $('cnCondition').value, sku: $('cnSku').value,
      taxScheme: $('cnTaxScheme').value, itemNotes: $('cnItemNotes').value,
      plannedSalePrice: $('cnPlannedSalePrice').value,
      minSalePrice: $('cnMinSalePrice').value,
      maxSalePrice: $('cnMaxSalePrice').value,
      attributes: merkmale.attributes, scopeOfDelivery: Array.from(CN.scope),
      agreedPrice: $('cnAgreedPrice').value, minimumPrice: $('cnMinimumPrice').value,
      expiryDate: $('cnExpiryDate').value, notes: $('cnNotes').value,
      payoutModel: $('cnPayoutModel').value,
      commissionRate: $('cnCommissionRate').value, excessSplitPct: $('cnExcessSplitPct').value,
    };
    return { form: form, fehler: merkmale.fehler };
  }

  async function cnAnlegen(opts) {
    const options = opts || {};
    const gesammelt = cnCreateForm();
    if (gesammelt.fehler.length) { cnSay('cnError', gesammelt.fehler.join(' ')); return; }
    const staged = await cnStageSlots();
    if (!staged.ok) { cnSay('cnError', 'A photo could not be uploaded (' + staged.code + ') — nothing was saved.'); return; }
    const gebaut = MobileConsignment.createBody(
      gesammelt.form, CN.slots.map((s) => s.stagingId).filter(Boolean),
      { acknowledgeDuplicate: options.acknowledgeDuplicate === true },
    );
    if (!gebaut.ok) { cnSay('cnError', CN_GRUND[gebaut.code] || gebaut.code); return; }
    // „Trotzdem anlegen" ist ein ANDERER Auftrag als der abgewiesene — er bekommt eine eigene
    // Kennung, damit die Wiederholung nicht auf den abgewiesenen Rumpf trifft.
    const key = 'create:' + CN.draftKey + (options.acknowledgeDuplicate ? ':dup' : '');
    const r = await cnClient.mutate(key, 'consignments.create', gebaut.body);
    if (r.kind === 'ok') {
      $('cnDuplicateCard').classList.add('hidden');
      const neu = r.value || {};
      if (neu.consignmentId) await cnOpen(neu.consignmentId, { keepMsgs: true });
      cnSay('cnSuccess', 'Saved as ' + (neu.consignmentNumber || 'a new consignment') + '.');
      return;
    }
    if (r.kind === 'rejected' && r.code === 'POSSIBLE_DUPLICATE') {
      // Die Duplikatserkennung des Hauses BLOCKIERT nicht, sie FRAGT — genau wie am Rechner.
      $('cnDuplicateCard').classList.remove('hidden');
      cnSay('cnDuplicateText', (r.message || 'This looks like an item we already have.')
        + ' Check the shelf first; press "Create anyway" only if it is really a second item.');
      cnSay('cnError', 'Not saved — please answer the duplicate question below.');
      await cnZeigeTreffer(gesammelt.form);
      return;
    }
    cnSay('cnError', cnMessageFor(r, 'The consignment was not saved'));
  }

  $('cnSaveBtn').onclick = async () => {
    if (CN.busy) return;
    cnClearMsgs();
    CN.busy = true;
    $('cnSaveBtn').disabled = true;
    const beschriftung = $('cnSaveBtn').textContent;
    $('cnSaveBtn').textContent = 'Saving…';
    try {
      if (CN.mode === 'create') {
        if (!CN.consignor) { cnSay('cnError', CN_GRUND.CONSIGNOR_REQUIRED); return; }
        await cnAnlegen({});
        return;
      }
      const form = cnFormValues();
      form.payoutModel = $('cnPayoutModel').value;
      form.commissionRate = $('cnCommissionRate').value;
      form.excessSplitPct = $('cnExcessSplitPct').value;
      const gebaut = MobileConsignment.editBody(CN.con, form);
      if (!gebaut.ok) { cnSay('cnError', CN_GRUND[gebaut.code] || gebaut.code); return; }
      if (!MobileConsignment.editHasChanges(gebaut.body)) { cnSay('cnError', 'Nothing changed.'); return; }
      const id = CN.con.id;
      const r = await cnClient.mutate('edit:' + id + ':' + CN.con.revision, 'consignments.update', gebaut.body);
      if (r.kind === 'ok') { await cnOpen(id, { keepMsgs: true }); cnSay('cnSuccess', 'Changes saved.'); return; }
      cnSay('cnError', r.code === 'RECORD_CHANGED'
        ? 'Someone changed this consignment in the meantime. Nothing was overwritten — open it again.'
        : cnMessageFor(r, 'The consignment was not saved'));
    } catch (err) {
      try { console.error('[consign] save failed: ' + ((err && err.stack) || String(err))); } catch (x) { /* egal */ }
      cnSay('cnError', 'Saved, but this screen could not be refreshed: ' + ((err && err.message) || String(err)));
    } finally {
      CN.busy = false;
      $('cnSaveBtn').disabled = false;
      $('cnSaveBtn').textContent = beschriftung;
      await cnRenderOpen();
    }
  };
  /**
   * Die Treffer des Hauses — und „Copy details" daraus.
   *
   * Beides kommt aus der Autoritaet: die Erkennung ist `findPossibleDuplicates`, die uebernommenen
   * Merkmale sind `copiedAttributes` (beide am Primary, gelesen ueber `products.duplicates.get`).
   * Das Telefon setzt nur, was die Maske zeigt — die SKU bleibt die des neuen Stuecks.
   */
  async function cnZeigeTreffer(form) {
    const box = $('cnDuplicateList');
    box.innerHTML = '';
    const r = await cnClient.read('products.duplicates.get', MobileConsignment.duplicateQuery(form));
    const items = (r.ok && r.value && r.value.items) || [];
    if (!items.length) return;
    items.forEach((m) => {
      const zeile = el('div', { class: 'row' });
      zeile.appendChild(el('div', { class: 'hint' },
        [m.brand, m.name, m.sku ? '(' + m.sku + ')' : '', m.matchClass ? '· ' + m.matchClass : ''].filter(Boolean).join(' ')));
      const b = el('button', { type: 'button', class: 'secondary', 'data-copy-details': m.id }, 'Copy details');
      b.onclick = () => { void cnUebernehmen(m); };
      zeile.appendChild(b);
      box.appendChild(zeile);
    });
  }

  async function cnUebernehmen(match) {
    const werte = MobileConsignment.copyDetails(match, { hasPhotos: CN.slots.length > 0 });
    if (werte.categoryId && werte.categoryId !== $('cnCategory').value) {
      $('cnCategory').value = werte.categoryId;
      cnRenderFields(werte.categoryId);
    }
    $('cnBrand').value = werte.brand;
    $('cnName').value = werte.name;
    const cond = $('cnCondition');
    const treffer = Array.from(cond.options).find((o) => o.value && o.value.toLowerCase() === werte.condition.toLowerCase());
    cond.value = treffer ? treffer.value : '';
    // Die Merkmale in die Felder DIESER Kategorie; was es hier nicht gibt, faellt weg.
    for (const key in werte.attributes) {
      const e = $(CN_ATTR_PREFIX + key);
      if (!e) continue;
      const wert = werte.attributes[key];
      if (e.tagName === 'SELECT') {
        const o = Array.from(e.options).find((x) => x.value && String(x.value).toLowerCase() === String(wert).toLowerCase());
        if (o) e.value = o.value;
      } else if (e.tagName === 'INPUT') {
        e.value = Array.isArray(wert) ? wert.join(', ') : String(wert);
      } else {
        // Chips (Mehrfachauswahl / Ja-Nein): die genannten anschalten.
        const gewaehlt = Array.isArray(wert) ? wert.map(String) : [String(wert)];
        for (const kind of e.children) {
          const an = gewaehlt.indexOf(kind.textContent) >= 0
            || (kind.dataset && kind.dataset.val === String(wert));
          kind.classList.toggle('on', an);
        }
      }
    }
    // Steuerart und Artikel-Notiz — der Rechner uebernimmt beide.
    const steuer = $('cnTaxScheme');
    const passend = Array.from(steuer.options).find((o) => o.value && o.value === werte.taxScheme);
    steuer.value = passend ? passend.value : '';
    $('cnItemNotes').value = werte.itemNotes;
    // Die Verkaufsvorstellungen: der Rechner setzt sie unbesehen, das Telefon auch. Ein Artikel
    // ohne solche Vorstellung laesst das Feld leer, statt eine Null hineinzuschreiben.
    for (let i = 0; i < CN_PRICE_FIELDS.length; i++) {
      const wert = werte[CN_PRICE_FIELDS[i]];
      $(CN_PRICE_INPUTS[i]).value = (wert === null || wert === undefined) ? '' : String(wert);
    }
    const cat = catById($('cnCategory').value);
    if (cat) applyDependencies(cat, CN_ATTR_PREFIX);
    // Lieferumfang: dieselbe Auswahl, die der gefundene Artikel hat.
    CN.scope.clear();
    const scopeHost = $('cnScope');
    for (const kind of scopeHost.children) {
      const an = werte.scopeOfDelivery.indexOf(kind.textContent) >= 0;
      kind.classList.toggle('on', an);
      if (an) CN.scope.add(kind.textContent);
    }
    // Bilder: NUR wenn noch keines an der Maske haengt (Regel des Rechners). Die Bytes kommen
    // ueber die angemeldete Medienroute; sie werden wie eigene Aufnahmen behandelt und beim
    // Speichern ganz normal in die Ablage gelegt.
    let fotos = 0;
    for (const key of werte.mediaKeys) {
      if (CN.slots.length >= MobileConsignment.MAX_PHOTOS) break;
      try {
        const res = await fetch('/api/media?key=' + encodeURIComponent(key), {
          headers: { Authorization: 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || '') },
        });
        if (!res.ok) continue;
        const blob = await res.blob();
        const dataUrl = await new Promise((fertig, schief) => {
          const leser = new FileReader();
          leser.onload = () => fertig(String(leser.result || ''));
          leser.onerror = () => schief(leser.error);
          leser.readAsDataURL(blob);
        });
        if (dataUrl.indexOf('data:image/') !== 0) continue;
        CN.slots.push({ dataUrl: dataUrl, src: dataUrl });
        fotos += 1;
      } catch (e) { /* ein Bild weniger ist kein Grund, die Uebernahme abzubrechen */ }
    }
    if (fotos) cnRenderPhotos();
    cnSay('cnSuccess', 'Details copied' + (fotos ? ' (with ' + fotos + ' photo' + (fotos === 1 ? '' : 's') + ')' : '')
      + ' — the reference stays yours. Check them, then press "Create anyway".');
  }

  $('cnCreateAnywayBtn').onclick = async () => {
    if (CN.busy) return;
    CN.busy = true;
    $('cnCreateAnywayBtn').disabled = true;
    try { await cnAnlegen({ acknowledgeDuplicate: true }); } finally {
      CN.busy = false;
      $('cnCreateAnywayBtn').disabled = false;
      await cnRenderOpen();
    }
  };

  // ── Galerie einer bestehenden Kommission ────────────────────────────────────────────────────
  $('cnGallerySaveBtn').onclick = async () => {
    if (CN.busy || !CN.product) return;
    CN.busy = true;
    $('cnGallerySaveBtn').disabled = true;
    try {
      const staged = await cnStageSlots();
      if (!staged.ok) { cnSay('cnError', 'A photo could not be uploaded (' + staged.code + ') — nothing was saved.'); return; }
      const plan = MobileConsignment.galleryPlan(CN.slots);
      const gebaut = MobileConsignment.galleryBody(CN.product.id, plan);
      if (!gebaut.ok) { cnSay('cnError', CN_GRUND[gebaut.code] || gebaut.code); return; }
      if (!CN.werkKeys.gallery) CN.werkKeys.gallery = uuid();
      const r = await cnClient.mutate('gallery:' + CN.product.id + ':' + CN.werkKeys.gallery, 'products.update', gebaut.body);
      if (r.kind === 'ok') {
        delete CN.werkKeys.gallery;
        await cnOpen(CN.con.id, { keepMsgs: true, keepForm: true });
        cnSay('cnSuccess', 'The photos were saved.');
        return;
      }
      cnSay('cnError', cnMessageFor(r, 'The photos were not saved'));
    } finally {
      CN.busy = false;
      $('cnGallerySaveBtn').disabled = false;
      await cnRenderOpen();
    }
  };

  // ── Handlungen an einer bestehenden Kommission ──────────────────────────────────────────────
  async function cnHandlung(op, zweck, bau, erfolgstext) {
    if (CN.busy || !CN.con) return false;
    cnSay('cnActionMsg', '', true);
    const res = bau();
    if (!res.ok) { cnSay('cnActionMsg', CN_GRUND[res.code] || res.code, false); return false; }
    CN.busy = true;
    try {
      if (!CN.werkKeys[zweck]) CN.werkKeys[zweck] = uuid();
      const key = zweck + ':' + CN.con.id + ':' + CN.werkKeys[zweck];
      const r = await cnClient.mutate(key, op, res.body);
      if (r.kind === 'ok') {
        delete CN.werkKeys[zweck];
        const id = CN.con.id;
        await cnOpen(id, { keepMsgs: true, keepForm: true });
        cnSay('cnActionMsg', erfolgstext, true);
        return true;
      }
      if (r.kind === 'rejected' && r.code === 'SALE_BELOW_FLOOR') {
        // Der Primary hat gerechnet, nicht das Telefon: erst sein Nein macht die Frage sichtbar.
        CN.shortfallOffen = true;
        $('cnShortfallMsg').classList.remove('hidden');
        $('cnShortfallMsg').textContent = (r.message || 'This sale is below the consignor floor.')
          + ' Press "Record sale" again to confirm — the difference is booked as a consignor loss.';
        cnSay('cnActionMsg', 'Not booked — the sale is below the consignor floor.', false);
        return false;
      }
      cnSay('cnActionMsg', r.code === 'RECORD_CHANGED'
        ? 'Someone changed this consignment in the meantime. Nothing was booked — open it again.'
        : cnMessageFor(r, 'Not booked'), false);
      return false;
    } finally {
      CN.busy = false;
      await cnRenderOpen();
    }
  }

  $('cnSaleBtn').onclick = async () => {
    const bestaetigt = CN.shortfallOffen === true;
    const gut = await cnHandlung('consignments.record_sale', bestaetigt ? 'sale-ack' : 'sale', () => MobileConsignment.saleBody(CN.con, {
      buyerId: CN.buyer ? CN.buyer.id : '', salePrice: $('cnSalePrice').value,
      specialMark: $('cnSpecialMark').value === 'special', notes: $('cnSaleNotes').value,
    }, { acknowledgeShortfall: bestaetigt }), 'The sale was recorded.');
    if (gut) {
      CN.shortfallOffen = false;
      $('cnShortfallMsg').classList.add('hidden');
      $('cnSalePrice').value = ''; $('cnSaleNotes').value = '';
      cnSetBuyer(null, '');
    }
  };
  $('cnPayoutBtn').onclick = async () => {
    const gut = await cnHandlung('consignments.record_payout', 'payout', () => MobileConsignment.payoutBody(CN.con, {
      amount: $('cnPayoutAmount').value, method: $('cnPayoutMethod').value, reference: $('cnPayoutReference').value,
    }), 'The payout was recorded.');
    if (gut) { $('cnPayoutAmount').value = ''; $('cnPayoutReference').value = ''; }
  };
  (function () {
    let sicher = false;
    $('cnReturnBtn').onclick = async () => {
      if (!sicher) { sicher = true; $('cnReturnBtn').textContent = 'Really return to the consignor?'; return; }
      $('cnReturnBtn').textContent = 'Return to consignor';
      sicher = false;
      await cnHandlung('consignments.mark_returned', 'return', () => MobileConsignment.returnBody(CN.con),
        'The item went back to the consignor.');
    };
  }());

  // ── AI ──────────────────────────────────────────────────────────────────────────────────────
  //
  // DERSELBE Weg wie im Anlegeformular (`/api/ai/identify`, Produktform): das Foto, die gewaehlte
  // Kategorie, und die Antwort fuellt NUR leere Felder — auch die Merkmale der Kategorie, ueber
  // denselben Uebernehmer (`aiApplyToForm`) mit den Feldern DIESER Maske. Gespeichert wird nichts.
  $('cnAiBtn').onclick = async () => {
    if (CN.busy || !CN.slots.length) { cnSay('cnAiMsg', 'Take a photo first.', false); return; }
    const erstes = CN.slots[0];
    const image = erstes.dataUrl || erstes.src;
    if (!image || image.indexOf('data:') !== 0) {
      cnSay('cnAiMsg', 'Add a new photo first — AI reads the photo you just took.', false);
      return;
    }
    CN.busy = true;
    $('cnAiBtn').textContent = 'Identifying…';
    cnSay('cnAiMsg', 'Reading the photo…', true);
    try {
      const res = await fetch('/api/ai/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || '') },
        body: JSON.stringify({
          category_id: $('cnCategory').value,
          image: image,
          hints: [$('cnBrand').value, $('cnName').value].filter(Boolean).join(' ').trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        cnSay('cnAiMsg', data.error ? String(data.error) : ('Identify failed (' + res.status + ').'), false);
      } else {
        const gefuellt = aiApplyToForm(data.result || {}, {
          brand: 'cnBrand', name: 'cnName', condition: 'cnCondition', attrPrefix: CN_ATTR_PREFIX,
        });
        cnSay('cnAiMsg', gefuellt
          ? ('Filled ' + gefuellt + ' empty field' + (gefuellt === 1 ? '' : 's') + ' — please check before saving.')
          : 'Nothing new recognised — your entries are unchanged.', gefuellt > 0);
      }
    } catch (e) {
      cnSay('cnAiMsg', 'Identify unavailable — you can still fill the form in by hand.', false);
    } finally {
      CN.busy = false;
      $('cnAiBtn').textContent = '✨  AI Identify';
    }
  };

  // ── Einstiege ───────────────────────────────────────────────────────────────────────────────
  (function cnInit() {
    const sel = $('cnCategory');
    sel.innerHTML = '';
    for (const c of SCHEMA.categories) sel.appendChild(el('option', { value: c.id }, c.name));
    sel.addEventListener('change', () => { $('cnCondition').value = ''; cnRenderFields(sel.value); });
    cnPayoutModellAuswahl();
    cnSteuerAuswahl();
    cnPayoutFelder();
    cnRenderFields(sel.value);
  }());
  $('cnNewBtn').onclick = cnNewIntake;
  $('cnSearchBtn').onclick = () => cnLoadList($('cnSearch').value);
  $('cnSearch').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); cnLoadList($('cnSearch').value); } };
  document.querySelectorAll('[data-back-consign]').forEach((btn) => {
    btn.onclick = () => { screen('consignHome'); cnRenderOpen(); cnLoadList($('cnSearch').value); };
  });
  async function cnHomeOpen() {
    screen('consignHome');
    cnClearMsgs();
    await cnLadeAuswahlen();
    await cnRenderOpen();
    await cnLoadList($('cnSearch').value);
  }
