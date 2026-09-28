  // ══ MOBILE-PURCHASE — die Oberflaeche ═════════════════════════════════════════════════════════
  //
  // Woertlich in die Seiten-IIFE eingebettet; sie benutzt deren Helfer ($, screen, uuid, resizePhoto,
  // TOKEN_KEY, idbReq, init) und die Feld-Bausteine des Anlegeformulars (SCHEMA, catById, makeControl,
  // applyDependencies, dependsSatisfied, readAttr, aiApplyToForm, ROW_PREFIX). Kategorien und Merkmale
  // kommen damit aus DERSELBEN SSOT wie am Rechner — keine zweite Feldliste, kein zweiter AI-Weg.
  //
  // Der Einkauf liegt als ENTWURF auf dem Telefon (IndexedDB, samt Fotos) und uebersteht Neustart,
  // Netzverlust und einen nicht erreichbaren Primary. „Book purchase" schickt EINEN Auftrag
  // (`purchases.create`) unter der durablen Kennung dieses Entwurfs; gebucht ist erst, was der Primary
  // bestaetigt. Drei Zustaende: Draft → Waiting for main computer → Booked.

  const MP_DB = 'lataif_mobile_purchase', MP_DRAFTS = 'drafts', MP_INTENTS = 'intents';
  const MP_PARTNERS_KEY = 'lataif_mobile_partners';
  function mpIdbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(MP_DB, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(MP_DRAFTS)) db.createObjectStore(MP_DRAFTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(MP_INTENTS)) db.createObjectStore(MP_INTENTS, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  function mpStoreOf(name) {
    return {
      async get(k) { const db = await mpIdbOpen(); return idbReq(db.transaction(name, 'readonly').objectStore(name).get(k)); },
      async put(e) { const db = await mpIdbOpen(); return idbReq(db.transaction(name, 'readwrite').objectStore(name).put(e)); },
      async delete(k) { const db = await mpIdbOpen(); return idbReq(db.transaction(name, 'readwrite').objectStore(name).delete(k)); },
      async getAll() { const db = await mpIdbOpen(); return idbReq(db.transaction(name, 'readonly').objectStore(name).getAll()); },
    };
  }
  const mpDrafts = mpStoreOf(MP_DRAFTS);
  // DERSELBE Auftraggeber wie bei Reparatur und Kommission — nur die Ablage ist eine eigene.
  const mpClient = MobileRepair.createClient({
    fetchFn: (u, o) => fetch(u, o),
    store: mpStoreOf(MP_INTENTS),
    genId: uuid,
    token: () => localStorage.getItem(TOKEN_KEY) || '',
  });

  const MPX = MobilePurchase;
  const MP = {
    draft: null, open: new Set(['supplier', 'items']), busy: false, sending: false, saveTimer: null,
    partners: null, results: { supplier: [], customer: [], product: {} }, issues: [],
  };
  const mpH = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mpToday = () => new Date().toISOString().split('T')[0];
  const mpShort = () => uuid().replace(/-/g, '').slice(0, 10);
  const mpLocked = () => !!MP.draft && MP.draft.status !== 'draft';

  function mpSay(id, text) {
    const e = $(id);
    if (!e) return;
    e.innerHTML = text || '';
    e.classList.toggle('hidden', !text);
    if (text && typeof e.scrollIntoView === 'function') { try { e.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (x) { /* alt */ } }
  }
  function mpClearMsgs() { mpSay('mpError', ''); mpSay('mpSuccess', ''); }

  // ── Partner: nur aktive, zwischengespeichert fuer den Betrieb ohne Netz ──────────────────────
  async function mpLoadPartners() {
    const r = await mpClient.read('store.partners.get', {});
    if (r.ok && r.value && r.value.data && Array.isArray(r.value.data.partners)) {
      const aktiv = r.value.data.partners.filter((p) => p && p.active).map((p) => ({ id: p.id, name: p.name }));
      MP.partners = aktiv;
      try { localStorage.setItem(MP_PARTNERS_KEY, JSON.stringify(aktiv)); } catch (e) { /* voll */ }
      return;
    }
    try { MP.partners = JSON.parse(localStorage.getItem(MP_PARTNERS_KEY) || 'null'); } catch (e) { MP.partners = null; }
  }
  const mpPartnerName = (id) => ((MP.partners || []).find((p) => p.id === id) || { name: id }).name;

  // ── Merkmale je Position: dieselben Bausteine, ein eigener Prefix je Position ─────────────────
  const mpPre = (it) => 'mpa' + it.uid + '_';
  const mpRowPre = (it) => 'mpr' + it.uid + '_';
  function mpDependsOk(a, attrs) {
    if (!a.dependsOn) return true;
    return a.dependsOn.valueIncludes.indexOf(attrs[a.dependsOn.key]) !== -1;
  }
  function mpWriteAttr(a, pre, v) {
    const e = $(pre + a.key);
    if (!e || v === undefined || v === null) return;
    if (a.type === 'multiselect') { for (const c of e.children) c.classList.toggle('on', Array.isArray(v) && v.indexOf(c.textContent) !== -1); return; }
    if (a.type === 'boolean') { for (const c of e.children) c.classList.toggle('on', c.dataset.val === String(v)); return; }
    e.value = String(v);
  }
  /** Die Merkmale einer AUFGEKLAPPTEN Position aus den Feldern lesen (unlesbare Zahlen merken). */
  function mpReadItemDom(it) {
    if (it.mode !== 'new' || !$('mpb' + it.uid)) return;
    it.brand = $('mpb' + it.uid).value;
    it.name = $('mpn' + it.uid).value;
    it.sku = $('mps' + it.uid).value;
    it.condition = $('mpc' + it.uid).value;
    const cat = catById(it.categoryId);
    const attrs = {}, bad = {};
    if (cat) {
      const pre = mpPre(it);
      for (const a of cat.attributes) {
        if (!$(pre + a.key)) continue;
        const v = readAttr(a, pre);
        if (a.type === 'number' && Number.isNaN(v)) { bad[a.key] = true; continue; }
        const leer = v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0);
        if (!leer) attrs[a.key] = v;
      }
    }
    it.attributes = attrs;
    it.badNumbers = bad;
  }
  /** Was die Kategorie verlangt, am ZUSTAND geprueft — auch fuer zugeklappte Positionen. */
  function mpFieldErrors(draft) {
    return draft.items.map((it) => {
      if (it.mode !== 'new') return [];
      const cat = catById(it.categoryId);
      const out = [];
      if (!cat) return out;
      for (const a of cat.attributes) {
        if (!mpDependsOk(a, it.attributes || {})) continue;
        if (it.badNumbers && it.badNumbers[a.key]) { out.push(a.label + ' must be a valid number ≥ 0.'); continue; }
        const v = (it.attributes || {})[a.key];
        const leer = v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0);
        if (leer && a.required) out.push(a.label + ' is required.');
      }
      return out;
    });
  }
  /** Verdeckte Merkmale (dependsOn) reisen nie mit — genau wie im Anlegeformular. */
  function mpCleanDraft(draft) {
    const copy = JSON.parse(JSON.stringify(draft));
    for (const it of copy.items) {
      const cat = catById(it.categoryId);
      if (!cat) { it.attributes = {}; continue; }
      const keep = {};
      for (const a of cat.attributes) if (mpDependsOk(a, it.attributes || {}) && it.attributes[a.key] !== undefined) keep[a.key] = it.attributes[a.key];
      it.attributes = keep;
    }
    return copy;
  }

  // ── Ablage ──────────────────────────────────────────────────────────────────────────────────
  async function mpPersist(draft) {
    const d = draft || MP.draft;
    if (!d) return;
    const now = new Date().toISOString();
    if (!d.createdAt) d.createdAt = now;
    d.updatedAt = now;
    try { await mpDrafts.put(JSON.parse(JSON.stringify(d))); } catch (e) { mpSay('mpError', 'This phone could not store the draft (' + ((e && e.message) || e) + ').'); }
  }
  function mpTouched() {
    mpUpdateSummaries();
    clearTimeout(MP.saveTimer);
    MP.saveTimer = setTimeout(() => { void mpPersist(); }, 500);
  }

  // ── Zeichnen ────────────────────────────────────────────────────────────────────────────────
  function mpSection(key, title, summary, body, sub) {
    const auf = MP.open.has(key);
    return '<div class="' + (sub ? 'mp-sub' : 'mp-sec') + (auf ? ' open' : '') + '" data-mp-sec="' + mpH(key) + '">'
      + '<button type="button" class="mp-head" data-mp-toggle="' + mpH(key) + '" aria-expanded="' + (auf ? 'true' : 'false') + '">'
      + '<span>' + mpH(title) + '</span><span class="mp-sum" data-mp-sum="' + mpH(key) + '">' + mpH(summary) + '</span><span class="caret">▸</span></button>'
      + (auf ? '<div class="mp-body">' + body + '</div>' : '') + '</div>';
  }

  function mpSupplierBody(d) {
    const s = d.supplier;
    const tab = (m, t) => '<button type="button" class="' + (s.mode === m ? 'on' : '') + '" data-mp-action="supplier-mode" data-mode="' + m + '">' + t + '</button>';
    let h = '<div class="mp-tabs">' + tab('existing', 'Supplier') + tab('customer', 'Client') + tab('person', 'New person') + '</div>';
    if (s.mode === 'existing' || s.mode === 'customer') {
      const was = s.mode === 'existing' ? 'supplier' : 'customer';
      h += '<div class="mp-two"><input id="mpSupSearch" type="search" placeholder="' + (was === 'supplier' ? 'search suppliers' : 'search clients (name)') + '" />'
        + '<button type="button" class="mp-small mp-ghost" style="flex:0 0 auto;" data-mp-action="search-' + was + '">Search</button></div>';
      if (s.name && ((s.mode === 'existing' && s.supplierId) || (s.mode === 'customer' && s.customerId))) {
        h += '<div class="mp-note">Chosen: <span class="mp-badge">' + mpH(s.name) + '</span></div>';
      }
      const liste = MP.results[was] || [];
      for (const r of liste) {
        const name = was === 'supplier' ? r.name : ([r.firstName, r.lastName].filter(Boolean).join(' ') || r.company || r.id);
        const aus = was === 'supplier' && r.active === false;
        h += '<button type="button" class="mp-pick" ' + (aus ? 'disabled ' : '') + 'data-mp-action="pick-' + was + '" data-id="' + mpH(r.id) + '" data-name="' + mpH(name)
          + '" data-updated="' + mpH(r.updatedAt || '') + '">' + mpH(name) + ' <span>' + mpH(r.phone || '') + (aus ? ' · inactive' : '') + '</span></button>';
      }
      if (s.mode === 'customer') h += '<p class="mp-note">The same person keeps one record: if this client is already our supplier, that supplier is used; otherwise the supplier role is linked to the client. Their accounts stay separate.</p>';
    } else {
      const p = s.person;
      h += '<div class="mp-row"><label>First name</label><input data-mp-field="person.firstName" value="' + mpH(p.firstName) + '" /></div>'
        + '<div class="mp-row"><label>Last name</label><input data-mp-field="person.lastName" value="' + mpH(p.lastName) + '" /></div>'
        + '<div class="mp-row"><label>Phone</label><input data-mp-field="person.phone" inputmode="tel" value="' + mpH(p.phone) + '" /></div>'
        + '<div class="mp-row"><label>Email</label><input data-mp-field="person.email" type="email" value="' + mpH(p.email) + '" /></div>'
        // Das Ausweisfoto ist OPTIONAL — derselbe Weg wie bei Reparatur und Kommission: aufnehmen,
        // verkleinern, vor dem Auftrag in die Ablage; im Auftrag nur die Kennung.
        + '<div class="header-row" style="margin:8px 0 6px;"><span style="font-size:13px;color:#A1A1AA;">ID / CPR photo (optional)</span>'
        + (p.idPhoto ? '<span class="badge">Captured</span>' : '') + '</div>'
        + (p.idPhoto
          ? '<div class="photo-strip"><div class="photo-thumb">'
            + (p.idPhoto.dataUrl ? '<img src="' + p.idPhoto.dataUrl + '" alt="ID photo" />' : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:11px;color:#8A8A93;text-align:center;">stored ✓</div>')
            + '<button type="button" class="rm" data-mp-action="id-photo-remove">✕</button></div></div>'
          : '<label for="mpIdPhoto" class="photo-area" style="min-height:70px;padding:12px;"><div>🪪 Take ID photo</div><div class="hint">passport or CPR card</div></label>')
        + '<input id="mpIdPhoto" class="hidden" type="file" accept="image/*" capture="environment" data-mp-id-photo="1" />'
        + '<p class="mp-note">Search the client list first — a new person is created as a client with a linked supplier role.</p>';
    }
    if (s.candidates || s.createDespite) {
      h += '<label style="display:flex;gap:8px;align-items:center;margin-top:12px;text-transform:none;letter-spacing:0;font-size:13px;color:#EAEAEA;">'
        + '<input type="checkbox" style="width:auto;" data-mp-field="createDespite"' + (s.createDespite ? ' checked' : '') + ' /> Create a new supplier anyway</label>';
    }
    return h;
  }

  function mpDetailsBody(d) {
    return '<div class="mp-row"><label>Purchase date *</label><input type="date" data-mp-field="purchaseDate" value="' + mpH(d.purchaseDate) + '" /></div>'
      + '<div class="mp-row"><label>Input VAT</label><select data-mp-field="taxScheme">'
      + '<option value="ZERO"' + (d.taxScheme === 'ZERO' ? ' selected' : '') + '>0 % (no input VAT)</option>'
      + '<option value="VAT_10"' + (d.taxScheme === 'VAT_10' ? ' selected' : '') + '>10 % (input VAT included)</option></select>'
      + '<p class="mp-note">Prices are what the supplier gets per piece. With 10 % the input VAT is taken out of that price — as on the desktop.</p></div>';
  }

  function mpPartnerBody(it) {
    const total = MPX.lineTotalF(it) / 1000;
    let h = '';
    it.partners.forEach((p, k) => {
      const opts = (MP.partners || []).map((x) => '<option value="' + mpH(x.id) + '"' + (x.id === p.partnerId ? ' selected' : '') + '>' + mpH(x.name) + '</option>').join('');
      h += '<div class="mp-row"><select data-mp-field="partner:' + it.uid + ':' + k + ':partnerId"><option value="">Choose partner…</option>' + opts + '</select>'
        + '<div class="mp-two" style="margin-top:6px;"><input inputmode="decimal" placeholder="%" data-mp-field="partner:' + it.uid + ':' + k + ':sharePct" value="' + mpH(p.sharePct) + '" />'
        + '<input inputmode="decimal" placeholder="or BHD" data-mp-field="partner:' + it.uid + ':' + k + ':amount" value="' + mpH(p.amount || '') + '" />'
        + '<button type="button" class="mp-small mp-danger" style="flex:0 0 auto;" data-mp-action="remove-partner" data-uid="' + it.uid + '" data-k="' + k + '">✕</button></div></div>';
    });
    if ((MP.partners || []).length > it.partners.length) {
      h += '<button type="button" class="mp-small mp-ghost" style="margin-top:10px;" data-mp-action="add-partner" data-uid="' + it.uid + '">＋ Add partner</button>';
    }
    const b = MPX.shareBreakdown(it);
    h += '<div class="mp-total" data-mp-share="' + it.uid + '"><span>LATAIF ' + (b.houseBp / 100) + ' %</span><b>' + MPX.fmt(b.houseCostF) + ' BHD</b></div>';
    for (const r of b.rows) h += '<div class="mp-total"><span>' + mpH(mpPartnerName(r.partnerId)) + ' ' + (r.bp / 100) + ' %</span><b>' + MPX.fmt(r.costF) + ' BHD</b></div>';
    h += '<p class="mp-note">A BHD amount is the partner\'s part of this position (' + MPX.fmt(MPX.F(total)) + ' BHD), rounded to 0.01 %. Partners pay only into LATAIF\'s cash, bank or benefit — never the supplier.</p>';
    return h;
  }

  function mpItemBody(it, i) {
    let h = '<div class="mp-tabs"><button type="button" class="' + (it.mode === 'new' ? 'on' : '') + '" data-mp-action="item-mode" data-uid="' + it.uid + '" data-mode="new">New item</button>'
      + '<button type="button" class="' + (it.mode === 'existing' ? 'on' : '') + '" data-mp-action="item-mode" data-uid="' + it.uid + '" data-mode="existing">Existing item</button></div>';
    if (it.mode === 'new') {
      h += '<div class="header-row" style="margin-bottom:6px;"><span style="font-size:13px;color:#A1A1AA;">Photos</span><span class="badge' + (it.photos.length ? '' : ' hidden') + '">' + it.photos.length + ' / ' + MPX.MAX_PHOTOS + '</span></div>'
        + '<label for="mpf' + it.uid + '" class="photo-area" style="min-height:90px;padding:16px;"><div>📷 ' + (it.photos.length ? 'Add more photos' : 'Take or choose photos') + '</div><div class="hint">first photo is the cover</div></label>'
        + '<input id="mpf' + it.uid + '" class="hidden" type="file" accept="image/*" capture="environment" multiple data-mp-photo-input="' + it.uid + '" />';
      if (it.photos.length) {
        h += '<div class="photo-strip">';
        it.photos.forEach((p, k) => {
          h += '<div class="photo-thumb' + (k === 0 ? ' is-primary' : '') + '" data-mp-action="photo-cover" data-uid="' + it.uid + '" data-k="' + k + '">'
            + (p.dataUrl ? '<img src="' + p.dataUrl + '" />' : '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:11px;color:#8A8A93;text-align:center;">stored ✓</div>') + (k === 0 ? '<div class="cover">FIRST</div>' : '')
            + '<button type="button" class="rm" data-mp-action="photo-remove" data-uid="' + it.uid + '" data-k="' + k + '">✕</button></div>';
        });
        h += '</div><button type="button" class="ghost" style="margin-top:10px;" data-mp-action="ai" data-uid="' + it.uid + '">✨&nbsp; AI Identify</button><div id="mpAi' + it.uid + '" style="font-size:12px;margin-top:6px;"></div>';
      }
      const cats = SCHEMA.categories.map((c) => '<option value="' + mpH(c.id) + '"' + (c.id === it.categoryId ? ' selected' : '') + '>' + mpH(c.name) + '</option>').join('');
      h += '<div class="mp-row" style="margin-top:12px;"><label>Category *</label><select data-mp-field="item:' + it.uid + ':categoryId">' + cats + '</select></div>'
        + '<div class="mp-row"><label>Brand *</label><input id="mpb' + it.uid + '" data-mp-field="item:' + it.uid + ':brand" value="' + mpH(it.brand) + '" /></div>'
        + '<div class="mp-row"><label>Model / Name *</label><input id="mpn' + it.uid + '" data-mp-field="item:' + it.uid + ':name" value="' + mpH(it.name) + '" /></div>'
        + '<div class="mp-row"><label>SKU / Reference</label><input id="mps' + it.uid + '" data-mp-field="item:' + it.uid + ':sku" placeholder="automatic if empty" value="' + mpH(it.sku) + '" /></div>'
        + '<div class="mp-row"><label>Condition</label><select id="mpc' + it.uid + '" data-mp-field="item:' + it.uid + ':condition"></select></div>'
        + '<div id="mpAttrs' + it.uid + '" data-mp-attrs="' + it.uid + '"></div>'
        + '<div class="mp-row hidden" id="mpScopeRow' + it.uid + '"><label>Included</label><div class="chips" id="mpScope' + it.uid + '"></div></div>';
    } else {
      h += '<div class="mp-two"><input id="mpPs' + it.uid + '" type="search" placeholder="search brand, name or SKU" />'
        + '<button type="button" class="mp-small mp-ghost" style="flex:0 0 auto;" data-mp-action="search-product" data-uid="' + it.uid + '">Search</button></div>';
      if (it.productId) h += '<div class="mp-note">Chosen: <span class="mp-badge">' + mpH(it.productLabel) + '</span></div>';
      for (const r of (MP.results.product[it.uid] || [])) {
        const label = [r.brand, r.name].filter(Boolean).join(' ') + (r.sku ? ' (' + r.sku + ')' : '');
        h += '<button type="button" class="mp-pick" data-mp-action="pick-product" data-uid="' + it.uid + '" data-id="' + mpH(r.id) + '" data-name="' + mpH(label) + '">'
          + mpH(label) + ' <span>in stock ' + mpH(r.quantity) + '</span></button>';
      }
      h += '<p class="mp-note">Adds pieces to an item that is already in the inventory.</p>';
    }
    h += '<div class="mp-two" style="margin-top:12px;"><div><label>Quantity *</label><input inputmode="numeric" data-mp-field="item:' + it.uid + ':quantity" value="' + mpH(it.quantity) + '" /></div>'
      + '<div><label>Price per piece (BHD) *</label><input inputmode="decimal" data-mp-field="item:' + it.uid + ':unitPrice" value="' + mpH(it.unitPrice) + '" /></div></div>'
      + '<div class="mp-total"><span>Position total</span><b data-mp-linetotal="' + it.uid + '">' + MPX.fmt(MPX.lineTotalF(it)) + ' BHD</b></div>';
    if (it.mode === 'new') h += '<div class="mp-row"><label>Item note</label><input data-mp-field="item:' + it.uid + ':itemNotes" placeholder="optional" value="' + mpH(it.itemNotes) + '" /></div>';
    // Partner nur, wenn es aktive gibt — sonst gar kein Bereich; standardmaessig zu, kein Pflichtschritt.
    if ((MP.partners || []).length) {
      const key = 'partner:' + it.uid;
      if (!it.partners.length && !MP.open.has(key)) {
        h += '<button type="button" class="mp-small mp-ghost" style="margin-top:12px;" data-mp-action="add-partner" data-uid="' + it.uid + '">＋ Add partner</button>';
      } else {
        h += mpSection(key, 'Partner participation', MPX.partnerSummary(it), mpPartnerBody(it), true);
      }
    }
    h += '<button type="button" class="mp-small mp-danger" style="margin-top:14px;" data-mp-action="remove-item" data-uid="' + it.uid + '">Remove item ' + (i + 1) + '</button>';
    return h;
  }

  function mpItemsBody(d) {
    let h = '';
    d.items.forEach((it, i) => { h += mpSection('item:' + it.uid, 'Item ' + (i + 1), MPX.itemSummary(it), mpItemBody(it, i), true); });
    h += '<button type="button" class="mp-small mp-ghost" style="margin-top:12px;" data-mp-action="add-item">＋ Add item</button>';
    const t = MPX.totals(d);
    h += '<div class="mp-total"><span>Purchase total</span><b data-mp-total>' + MPX.fmt(t.totalF) + ' BHD</b></div>';
    return h;
  }

  function mpPaymentsBody(d) {
    let h = '';
    d.payments.forEach((p, k) => {
      const opt = (m, t) => '<option value="' + m + '"' + (p.method === m ? ' selected' : '') + '>' + t + '</option>';
      h += '<div class="mp-row"><div class="mp-two"><select data-mp-field="pay:' + k + ':method">' + opt('cash', 'Cash') + opt('bank', 'Bank') + opt('benefit', 'Benefit') + '</select>'
        + '<input inputmode="decimal" placeholder="Amount (BHD)" data-mp-field="pay:' + k + ':amount" value="' + mpH(p.amount) + '" />'
        + '<button type="button" class="mp-small mp-danger" style="flex:0 0 auto;" data-mp-action="remove-payment" data-k="' + k + '">✕</button></div>'
        + '<input style="margin-top:6px;" placeholder="Reference (optional)" data-mp-field="pay:' + k + ':reference" value="' + mpH(p.reference) + '" /></div>';
    });
    if (d.payments.length < MPX.MAX_PAYMENTS) h += '<button type="button" class="mp-small mp-ghost" style="margin-top:12px;" data-mp-action="add-payment">＋ Add payment</button>';
    const t = MPX.totals(d);
    h += '<div class="mp-total"><span>Paid</span><b data-mp-paid>' + MPX.fmt(t.paidF) + ' BHD</b></div>'
      + '<div class="mp-total"><span>Open with the supplier</span><b data-mp-open>' + MPX.fmt(Math.max(0, t.openF)) + ' BHD</b></div>'
      + '<p class="mp-note">Each payment is booked on its own from LATAIF\'s cash, bank or benefit. What stays open is owed to the supplier.</p>';
    return h;
  }

  function mpRender() {
    const d = MP.draft;
    if (!d) return;
    $('mpSubline').textContent = d.status === 'confirmed' ? 'Purchase booked' : (d.status === 'pending' ? 'Waiting for main computer' : 'New Purchase');
    const html = mpSection('supplier', 'Supplier', MPX.supplierSummary(d), mpSupplierBody(d))
      + mpSection('details', 'Purchase details', d.purchaseDate + ' · ' + (d.taxScheme === 'VAT_10' ? 'VAT 10 %' : 'no VAT'), mpDetailsBody(d))
      + mpSection('items', 'Items', MPX.itemsSummary(d), mpItemsBody(d))
      + mpSection('payments', 'Payments', MPX.paymentsSummary(d), mpPaymentsBody(d))
      + mpSection('notes', 'Notes', (d.notes || '').slice(0, 30) || 'none', '<textarea rows="3" data-mp-field="notes" placeholder="optional">' + mpH(d.notes) + '</textarea>');
    $('mpSections').innerHTML = html;
    for (const it of d.items) if (it.mode === 'new' && $('mpAttrs' + it.uid)) mpRenderItemFields(it);
    mpRenderStatus();
    if (mpLocked()) {
      for (const e of $('mpSections').querySelectorAll('input, select, textarea, button')) {
        if (!e.hasAttribute('data-mp-toggle')) e.disabled = true;
      }
    }
    $('mpActions').classList.toggle('hidden', mpLocked());
  }

  /** Zustand und Merkmale einer aufgeklappten Position in ihre Felder (Kategorie-Bausteine der Seite). */
  function mpRenderItemFields(it) {
    const cat = catById(it.categoryId);
    const pre = mpPre(it);
    ROW_PREFIX[pre] = mpRowPre(it);
    const cs = $('mpc' + it.uid);
    cs.innerHTML = '<option value="">— Select —</option>' + (cat ? cat.conditionOptions : []).map((o) => '<option value="' + mpH(o) + '">' + mpH(o) + '</option>').join('');
    cs.value = it.condition || '';
    const host = $('mpAttrs' + it.uid);
    host.innerHTML = '';
    if (cat) {
      for (const a of cat.attributes) {
        const row = document.createElement('div');
        row.className = 'row'; row.id = mpRowPre(it) + a.key;
        const lbl = document.createElement('label');
        lbl.innerHTML = mpH(a.label) + (a.unit ? ' (' + mpH(a.unit) + ')' : '') + (a.required ? ' <span class="req">*</span>' : '');
        row.appendChild(lbl);
        row.appendChild(makeControl(a, pre));
        host.appendChild(row);
      }
      for (const a of cat.attributes) mpWriteAttr(a, pre, (it.attributes || {})[a.key]);
      for (const a of cat.attributes) {
        if (!a.dependsOn) continue;
        const dep = $(pre + a.dependsOn.key);
        if (dep && dep.tagName === 'SELECT') dep.addEventListener('change', () => applyDependencies(cat, pre));
      }
      applyDependencies(cat, pre);
    }
    const scopeRow = $('mpScopeRow' + it.uid), scopeHost = $('mpScope' + it.uid);
    scopeHost.innerHTML = '';
    if (cat && cat.scopeOptions.length) {
      scopeRow.classList.remove('hidden');
      for (const o of cat.scopeOptions) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'chip' + ((it.scopeOfDelivery || []).indexOf(o) !== -1 ? ' on' : ''); b.textContent = o;
        b.onclick = () => {
          const i = it.scopeOfDelivery.indexOf(o);
          if (i === -1) it.scopeOfDelivery.push(o); else it.scopeOfDelivery.splice(i, 1);
          b.classList.toggle('on', i === -1);
          mpTouched();
        };
        scopeHost.appendChild(b);
      }
    } else scopeRow.classList.add('hidden');
  }

  function mpRenderStatus() {
    const d = MP.draft, bar = $('mpStatusBar');
    if (d.status === 'draft') {
      bar.classList.toggle('hidden', !d.lastError);
      bar.innerHTML = d.lastError ? '<span class="mp-badge draft">Draft</span><div class="mp-note" style="color:#AA6E6E;">' + mpH(d.lastError) + '</div>' : '';
      return;
    }
    bar.classList.remove('hidden');
    if (d.status === 'pending') {
      bar.innerHTML = '<span class="mp-badge wait">Waiting for main computer</span>'
        + '<div class="mp-note">' + mpH(d.lastError || 'Sending…') + '</div>'
        + '<button type="button" class="mp-small" style="margin-top:10px;" data-mp-action="resend">Send again</button>'
        + (d.sent ? '' : '<button type="button" class="mp-small mp-ghost" style="margin-top:10px;margin-left:8px;" data-mp-action="edit-again">Edit again</button>')
        + '<p class="mp-note">Not booked until the main computer confirms. Sending again never books twice — it is the same save.</p>';
      return;
    }
    const r = d.result || {};
    bar.innerHTML = '<span class="mp-badge">Booked</span>'
      + '<div style="font-size:15px;margin-top:8px;">' + mpH(r.purchaseNumber || 'Purchase') + '</div>'
      + '<div class="mp-total"><span>Total</span><b>' + MPX.fmt(MPX.F(r.totalAmount || 0)) + ' BHD</b></div>'
      + '<div class="mp-total"><span>Paid</span><b>' + MPX.fmt(MPX.F(r.paidAmount || 0)) + ' BHD</b></div>'
      + '<div class="mp-total"><span>Open with the supplier</span><b>' + MPX.fmt(MPX.F(r.openAmount || 0)) + ' BHD</b></div>'
      + '<button type="button" class="mp-small" style="margin-top:12px;" data-mp-action="new-purchase">New purchase</button>';
  }

  /** Nur die Zusammenfassungen und Summen nachziehen — ohne neu zu zeichnen (der Fokus bleibt). */
  function mpUpdateSummaries() {
    const d = MP.draft;
    if (!d) return;
    const set = (sel, text) => { const e = document.querySelector(sel); if (e) e.textContent = text; };
    set('[data-mp-sum="supplier"]', MPX.supplierSummary(d));
    set('[data-mp-sum="details"]', d.purchaseDate + ' · ' + (d.taxScheme === 'VAT_10' ? 'VAT 10 %' : 'no VAT'));
    set('[data-mp-sum="items"]', MPX.itemsSummary(d));
    set('[data-mp-sum="payments"]', MPX.paymentsSummary(d));
    set('[data-mp-sum="notes"]', (d.notes || '').slice(0, 30) || 'none');
    const t = MPX.totals(d);
    set('[data-mp-total]', MPX.fmt(t.totalF) + ' BHD');
    set('[data-mp-paid]', MPX.fmt(t.paidF) + ' BHD');
    set('[data-mp-open]', MPX.fmt(Math.max(0, t.openF)) + ' BHD');
    for (const it of d.items) {
      set('[data-mp-sum="item:' + it.uid + '"]', MPX.itemSummary(it));
      set('[data-mp-linetotal="' + it.uid + '"]', MPX.fmt(MPX.lineTotalF(it)) + ' BHD');
      set('[data-mp-sum="partner:' + it.uid + '"]', MPX.partnerSummary(it));
    }
  }

  // ── Eingaben ────────────────────────────────────────────────────────────────────────────────
  const mpItem = (uid) => MP.draft.items.find((x) => x.uid === uid);
  $('mpSections').addEventListener('input', (ev) => mpField(ev.target));
  $('mpSections').addEventListener('change', (ev) => mpField(ev.target, true));
  function mpField(t, changed) {
    const d = MP.draft;
    if (!d || mpLocked()) return;
    const f = t && t.getAttribute ? t.getAttribute('data-mp-field') : null;
    if (!f) {
      // Ein Merkmal der Kategorie: aus den Feldern der Position neu lesen.
      const host = t && t.closest ? t.closest('[data-mp-attrs]') : null;
      if (host) { const it = mpItem(host.getAttribute('data-mp-attrs')); if (it) { mpReadItemDom(it); mpTouched(); } }
      return;
    }
    const v = t.type === 'checkbox' ? t.checked : t.value;
    const p = f.split(':');
    if (f === 'purchaseDate' || f === 'taxScheme' || f === 'notes') d[f] = v;
    else if (f === 'createDespite') d.supplier.createDespite = !!v;
    else if (p[0].indexOf('person.') === 0) d.supplier.person[p[0].slice(7)] = v;
    else if (p[0] === 'pay') d.payments[Number(p[1])][p[2]] = v;
    else if (p[0] === 'item') {
      const it = mpItem(p[1]);
      if (!it) return;
      it[p[2]] = v;
      if (p[2] === 'categoryId' && changed) { it.attributes = {}; it.condition = ''; it.scopeOfDelivery = []; mpRender(); }
      if ((p[2] === 'quantity' || p[2] === 'unitPrice') && it.partners.length) {
        // Ein BHD-Anteil folgt der neuen Positionssumme.
        for (const q of it.partners) if (q.amount) { const pct = MPX.pctOfAmount(q.amount, MPX.lineTotalF(it) / 1000); if (pct !== null) q.sharePct = String(pct); }
      }
    } else if (p[0] === 'partner') {
      const it = mpItem(p[1]);
      if (!it) return;
      const q = it.partners[Number(p[2])];
      if (p[3] === 'amount') {
        q.amount = v;
        const pct = MPX.pctOfAmount(v, MPX.lineTotalF(it) / 1000);
        if (pct !== null) { q.sharePct = String(pct); const e = document.querySelector('[data-mp-field="partner:' + it.uid + ':' + p[2] + ':sharePct"]'); if (e) e.value = q.sharePct; }
      } else if (p[3] === 'sharePct') { q.sharePct = v; q.amount = ''; const e = document.querySelector('[data-mp-field="partner:' + it.uid + ':' + p[2] + ':amount"]'); if (e) e.value = ''; }
      else q[p[3]] = v;
      if (changed) { mpRender(); }
    }
    mpTouched();
  }
  // Chips der Merkmale (Mehrfachauswahl, Ja/Nein) aendern sich per Klick, nicht per Eingabe.
  $('mpSections').addEventListener('click', (ev) => {
    const chip = ev.target && ev.target.closest ? ev.target.closest('.chip') : null;
    const host = chip ? chip.closest('[data-mp-attrs]') : null;
    if (host) setTimeout(() => { const it = mpItem(host.getAttribute('data-mp-attrs')); if (it && !mpLocked()) { mpReadItemDom(it); mpTouched(); } }, 0);
  });

  // Fotos je Position.
  $('mpSections').addEventListener('change', async (ev) => {
    // Das Ausweisfoto der neuen Person.
    if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-mp-id-photo') && MP.draft && !mpLocked()) {
      const f = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      for (const it of MP.draft.items) mpReadItemDom(it);
      try { MP.draft.supplier.person.idPhoto = { dataUrl: await resizePhoto(f, 1600, 0.85) }; } catch (e) { mpSay('mpError', 'That ID photo could not be read.'); return; }
      mpRender();
      await mpPersist();
      return;
    }
    const uid = ev.target && ev.target.getAttribute ? ev.target.getAttribute('data-mp-photo-input') : null;
    if (!uid || mpLocked()) return;
    const it = mpItem(uid);
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    let abgelehnt = 0;
    mpReadItemDom(it);
    for (const f of files) {
      if (it.photos.length >= MPX.MAX_PHOTOS) { abgelehnt += 1; continue; }
      try { it.photos.push({ id: mpShort(), dataUrl: await resizePhoto(f, 1600, 0.85) }); } catch (e) { abgelehnt += 1; }
    }
    mpRender();
    await mpPersist();
    if (abgelehnt) mpSay('mpError', abgelehnt + ' photo(s) not added — at most ' + MPX.MAX_PHOTOS + ' per item.');
  });

  // ── Knoepfe ─────────────────────────────────────────────────────────────────────────────────
  $('mpSections').addEventListener('click', (ev) => { void mpClick(ev); });
  $('mpStatusBar').addEventListener('click', (ev) => { void mpClick(ev); });
  async function mpClick(ev) {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-mp-toggle], [data-mp-action]') : null;
    if (!b || !MP.draft) return;
    const d = MP.draft;
    // Vor jedem Neuzeichnen die aufgeklappten Positionen aus ihren Feldern lesen.
    if (!mpLocked()) for (const it of d.items) mpReadItemDom(it);
    const toggle = b.getAttribute('data-mp-toggle');
    if (toggle) { if (MP.open.has(toggle)) MP.open.delete(toggle); else MP.open.add(toggle); mpRender(); return; }
    const a = b.getAttribute('data-mp-action');
    const uid = b.getAttribute('data-uid');
    const k = Number(b.getAttribute('data-k'));
    if (a === 'resend') { await mpSend(d, { manual: true }); return; }
    if (a === 'edit-again') { if (!d.sent) { d.status = 'draft'; d.lastError = ''; await mpPersist(); mpRender(); } return; }
    if (a === 'new-purchase') { await mpNew(); return; }
    if (mpLocked()) return;
    ev.preventDefault();
    if (a === 'supplier-mode') {
      const m = b.getAttribute('data-mode');
      if (m !== d.supplier.mode) { d.supplier.mode = m; d.supplier.supplierId = ''; d.supplier.customerId = ''; d.supplier.name = ''; d.supplier.candidates = false; d.supplier.createDespite = false; }
    } else if (a === 'search-supplier' || a === 'search-customer') {
      const was = a === 'search-supplier' ? 'supplier' : 'customer';
      const q = ($('mpSupSearch') || { value: '' }).value;
      const r = await mpClient.read(was === 'supplier' ? 'suppliers.list' : 'customers.list', { q: q, limit: 15 });
      if (!r.ok) { mpSay('mpError', 'Search needs the main computer (' + r.code + ').'); return; }
      MP.results[was] = (r.value && r.value.items) || [];
      if (!MP.results[was].length) mpSay('mpError', 'Nothing found.');
    } else if (a === 'pick-supplier') {
      d.supplier.supplierId = b.getAttribute('data-id'); d.supplier.name = b.getAttribute('data-name'); MP.results.supplier = [];
    } else if (a === 'pick-customer') {
      d.supplier.customerId = b.getAttribute('data-id'); d.supplier.name = b.getAttribute('data-name');
      d.supplier.customerUpdatedAt = b.getAttribute('data-updated'); MP.results.customer = [];
    } else if (a === 'add-item') {
      if (d.items.length >= MPX.MAX_ITEMS) return;
      const it = MPX.newItem(mpShort(), (SCHEMA.categories[0] || {}).id || '');
      d.items.push(it);
      MP.open.add('item:' + it.uid);
    } else if (a === 'remove-item') {
      d.items = d.items.filter((x) => x.uid !== uid);
    } else if (a === 'item-mode') {
      const it = mpItem(uid); it.mode = b.getAttribute('data-mode');
    } else if (a === 'search-product') {
      const q = ($('mpPs' + uid) || { value: '' }).value;
      const r = await mpClient.read('products.list', { q: q, limit: 10 });
      if (!r.ok) { mpSay('mpError', 'Search needs the main computer (' + r.code + ').'); return; }
      MP.results.product[uid] = (r.value && r.value.items) || [];
    } else if (a === 'pick-product') {
      const it = mpItem(uid); it.productId = b.getAttribute('data-id'); it.productLabel = b.getAttribute('data-name'); MP.results.product[uid] = [];
    } else if (a === 'add-partner') {
      const it = mpItem(uid);
      if (it.partners.length < (MP.partners || []).length) it.partners.push({ partnerId: '', sharePct: it.partners.length ? '' : '50', amount: '' });
      MP.open.add('partner:' + uid);
    } else if (a === 'remove-partner') {
      const it = mpItem(uid); it.partners.splice(k, 1);
      if (!it.partners.length) MP.open.delete('partner:' + uid);
    } else if (a === 'add-payment') {
      if (d.payments.length < MPX.MAX_PAYMENTS) {
        const p = MPX.newPayment();
        const t = MPX.totals(d);
        if (t.openF > 0) p.amount = String(MPX.B(t.openF));
        d.payments.push(p);
      }
    } else if (a === 'remove-payment') {
      d.payments.splice(k, 1);
    } else if (a === 'id-photo-remove') {
      ev.stopPropagation();
      d.supplier.person.idPhoto = null;
    } else if (a === 'photo-remove') {
      ev.stopPropagation();
      mpItem(uid).photos.splice(k, 1);
    } else if (a === 'photo-cover') {
      const it = mpItem(uid);
      if (k > 0) { const [p] = it.photos.splice(k, 1); it.photos.unshift(p); }
    } else if (a === 'ai') {
      await mpAi(mpItem(uid));
      return;
    } else return;
    mpRender();
    await mpPersist();
  }

  // ── AI: dieselbe Route, nur leere Felder, nur beschreibende Felder ───────────────────────────
  async function mpAi(it) {
    const msg = $('mpAi' + it.uid);
    const first = it.photos[0];
    if (!first || !first.dataUrl) { if (msg) msg.textContent = 'Take a photo first.'; return; }
    if (MP.busy) return;
    MP.busy = true;
    if (msg) { msg.style.color = '#6B6B73'; msg.textContent = 'Reading the photo…'; }
    try {
      const res = await fetch('/api/ai/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || '') },
        body: JSON.stringify({ category_id: it.categoryId, image: first.dataUrl, hints: [it.brand, it.name].filter(Boolean).join(' ').trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = data.error ? String(data.error) : ('Identify failed (' + res.status + ').'); }
      } else {
        // Preise, Mengen, Partner und Zahlungen kann die AI nicht setzen: sie fuellt nur Marke, Modell,
        // Zustand und Merkmale — und nur, wo noch nichts steht.
        const n = aiApplyToForm(data.result || {}, { brand: 'mpb' + it.uid, name: 'mpn' + it.uid, condition: 'mpc' + it.uid, attrPrefix: mpPre(it) });
        mpReadItemDom(it);
        await mpPersist();
        mpUpdateSummaries();
        if (msg) { msg.style.color = n ? '#7FA87F' : '#6B6B73'; msg.textContent = n ? ('Suggested ' + n + ' empty field' + (n === 1 ? '' : 's') + ' — please check.') : 'Nothing new recognised — your entries are unchanged.'; }
      }
    } catch (e) {
      if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'Identify unavailable — fill in by hand.'; }
    } finally { MP.busy = false; }
  }

  // ── Buchen ──────────────────────────────────────────────────────────────────────────────────
  const MP_WORDS = {
    SUPPLIER_CANDIDATES_EXIST: 'An existing supplier may be this person. Pick that supplier under “Supplier”, or tick “Create a new supplier anyway”.',
    CUSTOMER_CHANGED: 'The client changed on another screen. Pick the client again.',
    PAYMENT_EXCEEDS_TOTAL: 'The payments are more than the purchase total.',
    PARTNER_NOT_ACTIVE: 'A partner is no longer active — choose another one or remove the partner.',
    SUPPLIER_NOT_FOUND: 'This supplier is not available — choose another one.',
    PRODUCT_NOT_FOUND: 'An existing item is not available any more — choose it again.',
    SKU_TAKEN: 'That SKU is already used by another item.',
  };
  function mpWords(r) {
    const code = r.code || '';
    return (MP_WORDS[code] || (r.message ? r.message : ('Refused by the main computer (' + (code || 'no reason') + ').'))) + (code ? ' [' + code + ']' : '');
  }

  $('mpSubmitBtn').onclick = async () => {
    const d = MP.draft;
    if (!d || MP.busy || mpLocked()) return;
    mpClearMsgs();
    for (const it of d.items) mpReadItemDom(it);
    const issues = MPX.validate(d, { fieldErrors: mpFieldErrors(d) });
    if (issues.length) {
      for (const x of issues) {
        if (x.where === 'supplier' || x.where === 'details' || x.where === 'payments' || x.where === 'items') MP.open.add(x.where);
        if (x.where.indexOf('item:') === 0) { MP.open.add('items'); const it = d.items[Number(x.where.slice(5))]; if (it) MP.open.add('item:' + it.uid); }
      }
      mpRender();
      mpSay('mpError', '<ul class="mp-issues">' + issues.map((x) => '<li>' + mpH(x.message) + '</li>').join('') + '</ul>');
      return;
    }
    d.status = 'pending'; d.sent = false; d.lastError = 'Sending…';
    await mpPersist();
    mpRender();
    await mpSend(d, { manual: true });
  };
  $('mpSaveBtn').onclick = async () => {
    if (!MP.draft || mpLocked()) return;
    for (const it of MP.draft.items) mpReadItemDom(it);
    await mpPersist();
    mpSay('mpSuccess', 'Draft saved on this phone.');
  };

  /**
   * Einen wartenden Einkauf zum Primary. Erst die Fotos in die Ablage (Kennung = Inhaltshash, also bei
   * jeder Wiederholung dieselbe), dann EIN Auftrag unter der Kennung dieses Entwurfs. Keine Antwort
   * heisst: vielleicht gebucht — der Einkauf bleibt „Waiting" und wird unter DERSELBEN Kennung erneut
   * geschickt; der Primary antwortet dann mit seinem eingefrorenen Ergebnis statt ein zweites Mal zu buchen.
   */
  async function mpSend(d, opts) {
    const o = opts || {};
    if (MP.sending || !d || d.status !== 'pending') return;
    MP.sending = true;
    const zeige = () => { if (MP.draft && MP.draft.id === d.id) mpRender(); };
    try {
      // Erst das Ausweisfoto der neuen Person, dann die Fotos der Positionen — alles in die Ablage,
      // bevor der eine Auftrag hinausgeht.
      const person = d.supplier.mode === 'person' ? d.supplier.person : null;
      const fotos = (person && person.idPhoto ? [person.idPhoto] : [])
        .concat(...d.items.filter((it) => it.mode === 'new').map((it) => it.photos));
      for (const p of fotos) {
        if (p.stagingId) continue;
        const r = await mpClient.stagePhoto(p.dataUrl);
        if (!r.ok) {
          const offline = /^HTTP_(0|5\d\d)$/.test(String(r.code));
          if (offline) {
            d.lastError = 'Not connected to the main computer — nothing was sent yet. It is sent when the main computer is reachable.';
            await mpPersist(d); zeige(); return;
          }
          d.status = 'draft'; d.lastError = 'A photo could not be uploaded (' + r.code + '). Nothing was booked.';
          await mpPersist(d); zeige(); return;
        }
        p.stagingId = r.stagingId;
        await mpPersist(d);
      }
      const built = MPX.buildBody(mpCleanDraft(d), (it) => it.photos.map((p) => p.stagingId).filter(Boolean));
      if (!built.ok) { d.status = 'draft'; d.lastError = built.issues[0].message; await mpPersist(d); zeige(); return; }
      d.sent = true;
      await mpPersist(d);
      const key = 'purchase:' + d.id;
      let r = await mpClient.mutate(key, 'purchases.create', built.body);
      if (r.kind === 'changed_while_open') r = await mpClient.mutate(key, 'purchases.create', built.body, { clarify: true });
      if (r.kind === 'ok') {
        const v = r.value || {};
        d.status = 'confirmed'; d.lastError = '';
        d.result = { purchaseId: v.purchaseId, purchaseNumber: v.purchaseNumber, totalAmount: v.totalAmount, paidAmount: v.paidAmount, openAmount: v.openAmount, confirmedAt: new Date().toISOString() };
        // Gebucht: die Fotobytes liegen jetzt am Primary; hier bleibt nur die Anzahl.
        for (const it of d.items) it.photos = it.photos.map((p) => ({ id: p.id, stagingId: p.stagingId }));
        if (d.supplier.person && d.supplier.person.idPhoto) d.supplier.person.idPhoto = { stagingId: d.supplier.person.idPhoto.stagingId };
        // Gebucht: nur noch die Zusammenfassungen zeigen — die Einzelheiten stehen am Rechner.
        if (MP.draft && MP.draft.id === d.id) MP.open.clear();
        await mpPersist(d); zeige();
        if (MP.draft && MP.draft.id === d.id) mpSay('mpSuccess', 'Booked as ' + mpH(v.purchaseNumber || 'a new purchase') + '.');
        return;
      }
      if (r.kind === 'rejected') {
        d.status = 'draft'; d.sent = false; d.lastError = mpWords(r);
        if (r.code === 'SUPPLIER_CANDIDATES_EXIST') { d.supplier.candidates = true; MP.open.add('supplier'); }
        await mpPersist(d); zeige();
        if (MP.draft && MP.draft.id === d.id) mpSay('mpError', mpH(d.lastError));
        return;
      }
      if (r.kind === 'unauthorized') {
        d.lastError = 'Your session ended — sign in again; the purchase keeps waiting.';
        await mpPersist(d); localStorage.removeItem(TOKEN_KEY); init(); return;
      }
      d.lastError = r.kind === 'conflict'
        ? 'The main computer holds this save for different content — nothing new was booked. Check the purchase on the desktop.'
        : 'No answer from the main computer (' + (r.code || 'no answer') + ') — it may already be booked. It is sent again under the same save, never twice.';
      // Die Statusleiste nennt den Grund — eine zweite Meldung darunter waere dieselbe.
      await mpPersist(d); zeige();
      if (o.manual && MP.draft && MP.draft.id === d.id) mpSay('mpError', '');
    } finally { MP.sending = false; }
  }

  /** Alles, was wartet, erneut schicken — beim Oeffnen, bei Netz und alle 30 Sekunden. */
  async function mpResendAll() {
    let all = [];
    try { all = await mpDrafts.getAll(); } catch (e) { return; }
    for (const d of all) {
      if (d.status !== 'pending') continue;
      const live = MP.draft && MP.draft.id === d.id ? MP.draft : d;
      await mpSend(live);
    }
    if (!$('mpHome').classList.contains('hidden')) await mpRenderHome();
  }
  window.addEventListener('online', () => { void mpResendAll(); });
  setInterval(() => { if (localStorage.getItem(TOKEN_KEY)) void mpResendAll(); }, 30000);

  // ── Uebersicht ──────────────────────────────────────────────────────────────────────────────
  async function mpRenderHome() {
    let all = [];
    try { all = await mpDrafts.getAll(); } catch (e) { mpSay('mpHomeMsg', 'Drafts could not be read on this phone.'); }
    all.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const box = $('mpDraftList');
    if (!all.length) { box.innerHTML = '<p class="mp-note">No purchases on this phone yet.</p>'; return; }
    box.innerHTML = all.map((d) => {
      const cls = d.status === 'confirmed' ? '' : (d.status === 'pending' ? ' wait' : ' draft');
      const titel = d.status === 'confirmed' && d.result && d.result.purchaseNumber ? d.result.purchaseNumber : MPX.supplierSummary(d);
      const loeschbar = d.status !== 'pending';
      return '<div class="card" style="padding:14px;" data-mp-draft="' + mpH(d.id) + '"><div class="mp-list-item"><div style="min-width:0;">'
        + '<div style="font-size:14px;">' + mpH(titel) + '</div><div class="mp-note" style="margin-top:4px;">' + mpH(MPX.itemsSummary(d)) + '</div></div>'
        + '<span class="mp-badge' + cls + '">' + mpH(MPX.statusLabel(d.status)) + '</span></div>'
        + '<div class="mp-two" style="margin-top:10px;"><button type="button" class="mp-small mp-ghost" data-mp-open="' + mpH(d.id) + '">Open</button>'
        + (loeschbar ? '<button type="button" class="mp-small mp-danger" data-mp-delete="' + mpH(d.id) + '">' + (d.status === 'confirmed' ? 'Remove from list' : 'Delete draft') + '</button>' : '')
        + '</div></div>';
    }).join('');
  }
  $('mpDraftList').addEventListener('click', async (ev) => {
    const o = ev.target.closest && ev.target.closest('[data-mp-open]');
    const del = ev.target.closest && ev.target.closest('[data-mp-delete]');
    if (o) {
      const d = await mpDrafts.get(o.getAttribute('data-mp-open'));
      if (d) mpOpen(d);
    } else if (del) {
      const id = del.getAttribute('data-mp-delete');
      if (del.getAttribute('data-really') !== '1') { del.setAttribute('data-really', '1'); del.textContent = 'Really?'; return; }
      const d = await mpDrafts.get(id);
      if (d && d.status !== 'pending') await mpDrafts.delete(id);
      await mpRenderHome();
    }
  });

  function mpOpen(d) {
    MP.draft = d;
    for (const it of d.items) { it.partners = it.partners || []; it.photos = it.photos || []; it.attributes = it.attributes || {}; it.scopeOfDelivery = it.scopeOfDelivery || []; }
    // Ein wartender oder gebuchter Einkauf zeigt zuerst nur seine Zusammenfassungen.
    MP.open = d.status === 'draft' ? new Set(['supplier', 'items']) : new Set();
    MP.results = { supplier: [], customer: [], product: {} };
    mpClearMsgs();
    screen('formMPurchase');
    mpRender();
  }
  async function mpNew() {
    const d = MPX.newDraft(uuid(), mpToday());
    const it = MPX.newItem(mpShort(), (SCHEMA.categories[0] || {}).id || '');
    d.items.push(it);
    await mpPersist(d);
    mpOpen(d);
    MP.open.add('item:' + it.uid);
    mpRender();
  }
  $('mpNewBtn').onclick = () => { void mpNew(); };
  $('mpBackBtn').onclick = async () => {
    if (MP.draft && !mpLocked()) { for (const it of MP.draft.items) mpReadItemDom(it); await mpPersist(); }
    await mpHomeOpen();
  };
  async function mpHomeOpen() {
    screen('mpHome');
    mpSay('mpHomeMsg', '');
    await mpRenderHome();
    await mpLoadPartners();
    void mpResendAll();
  }
