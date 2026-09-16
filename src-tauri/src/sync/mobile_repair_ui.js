  // ══ PRE-G5 MOBILE REPAIR — die Oberflaeche ═══════════════════════════════════════════════════
  //
  // Diese Datei wird woertlich IN die Seiten-IIFE eingebettet und benutzt deren Helfer ($, screen,
  // el, uuid, resizePhoto, TOKEN_KEY). Die Auftraege stellt `MobileRepair` (mobile_repair_commands.js);
  // hier steht nur, was der Benutzer sieht und anfasst.
  //
  // Der Vertrag: das Telefon LIEST ueber `repairs.list` / `repairs.get` und SCHREIBT ueber
  // `repairs.create` / `repairs.update` / `repairs.update_status` — dieselben Fernbefehle, die PC2
  // benutzt. Fotos gehen vorher in die Ablage des Primary. Nummer, Gutscheincode, Status,
  // Filiale, Mandant, Benutzer und alle Betragsableitungen macht der Primary.

  const RP_DB = 'lataif_mobile_repair', RP_STORE = 'repairIntents';
  function rpIdbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(RP_DB, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(RP_STORE)) db.createObjectStore(RP_STORE, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  const rpStore = {
    async get(k) { const db = await rpIdbOpen(); return idbReq(db.transaction(RP_STORE, 'readonly').objectStore(RP_STORE).get(k)); },
    async put(e) { const db = await rpIdbOpen(); return idbReq(db.transaction(RP_STORE, 'readwrite').objectStore(RP_STORE).put(e)); },
    async delete(k) { const db = await rpIdbOpen(); return idbReq(db.transaction(RP_STORE, 'readwrite').objectStore(RP_STORE).delete(k)); },
    async getAll() { const db = await rpIdbOpen(); return idbReq(db.transaction(RP_STORE, 'readonly').objectStore(RP_STORE).getAll()); },
  };
  const rpClient = MobileRepair.createClient({
    fetchFn: (u, o) => fetch(u, o),
    store: rpStore,
    genId: uuid,
    token: () => localStorage.getItem(TOKEN_KEY) || '',
  });

  // Maskenfeld je Repair-Feld — eine Zuordnung, von Lesen und Schreiben gemeinsam benutzt.
  const RP_INPUTS = {
    issueDescription: 'rpIssue', itemBrand: 'rpBrand', itemModel: 'rpModel',
    itemReference: 'rpReference', itemSerial: 'rpSerial', itemDescription: 'rpItemDescription',
    estimatedCost: 'rpEstimatedCost', estimatedReady: 'rpEstimatedReady',
    diagnosis: 'rpDiagnosis', notes: 'rpNotes',
  };
  // `slots` sind die Bilder in der Reihenfolge, die der Benutzer sieht: entweder ein GESPEICHERTES
  // (`keep` = sein Platz in der gespeicherten Liste) oder ein NEUES (Daten-URL, spaeter eine
  // Staging-Kennung). Genau daraus wird der Bildplan der Aenderung.
  const RP = { mode: 'create', repair: null, slots: [], customer: null, draftKey: null, busy: false };

  function rpFormValues() {
    const f = {};
    for (const k in RP_INPUTS) f[k] = $(RP_INPUTS[k]).value;
    return f;
  }
  function rpFillForm(v) {
    for (const k in RP_INPUTS) $(RP_INPUTS[k]).value = (v && v[k] !== null && v[k] !== undefined) ? String(v[k]) : '';
  }
  function rpSay(id, text, good) {
    const el2 = $(id);
    // Eine Meldung, die ins Leere geht, waere die schlimmste Sorte Fehler: der Benutzer haelt ein
    // stummes Fenster fuer Erfolg. Fehlt das Feld, sagt es wenigstens die Konsole.
    if (!el2) { try { console.error('[repair] message target missing: ' + id + ' — ' + text); } catch (e) { /* egal */ } return; }
    el2.textContent = text || '';
    el2.classList.toggle('hidden', !text);
    if (good !== undefined && id === 'rpAiMsg') el2.style.color = good ? '#7FA87F' : '#AA6E6E';
  }
  function rpClearMsgs() { rpSay('rpError', ''); rpSay('rpSuccess', ''); rpSay('rpAiMsg', ''); }

  // ── Bilder ───────────────────────────────────────────────────────────────────────────────────
  function rpRenderPhotos() {
    const strip = $('rpPhotoStrip'), area = $('rpPhotoArea'), hint = $('rpPhotoHint'), status = $('rpPhotoStatus');
    strip.innerHTML = '';
    const has = RP.slots.length > 0;
    strip.classList.toggle('hidden', !has);
    hint.classList.toggle('hidden', !has);
    status.classList.toggle('hidden', !has);
    if (has) status.textContent = RP.slots.length + ' / ' + MobileRepair.MAX_PHOTOS;
    area.classList.remove('has-image');
    area.innerHTML = has
      ? '<div class="icon">📷</div><div>Add more photos</div><div class="hint">' + RP.slots.length + ' of ' + MobileRepair.MAX_PHOTOS + '</div>'
      : '<div class="icon">📷</div><div>Tap to take photos</div><div class="hint">the item as handed in — up to 6</div>';
    RP.slots.forEach((slot, i) => {
      const t = el('div', { class: 'photo-thumb' + (i === 0 ? ' is-primary' : '') });
      const im = el('img'); im.src = slot.src || slot.dataUrl; t.appendChild(im);
      if (i === 0) t.appendChild(el('div', { class: 'cover' }, 'FIRST'));
      const rm = el('button', { type: 'button', class: 'rm' }, '✕');
      rm.onclick = (ev) => { ev.stopPropagation(); ev.preventDefault(); RP.slots.splice(i, 1); rpRenderPhotos(); };
      t.appendChild(rm);
      t.onclick = () => { if (i === 0) return; const [p] = RP.slots.splice(i, 1); RP.slots.unshift(p); rpRenderPhotos(); };
      strip.appendChild(t);
    });
    $('rpAiBtn').classList.toggle('hidden', !has);
  }
  $('rpPhotoInput').onchange = async (e) => {
    const files = Array.from((e.target && e.target.files) || []);
    if (!files.length) return;
    let rejected = 0;
    for (const f of files) {
      if (RP.slots.length >= MobileRepair.MAX_PHOTOS) { rejected += 1; continue; }
      try {
        const dataUrl = await resizePhoto(f, 1600, 0.85);
        RP.slots.push({ dataUrl: dataUrl, src: dataUrl });
      } catch (err) { rejected += 1; }
    }
    $('rpPhotoInput').value = '';
    rpRenderPhotos();
    if (rejected) rpSay('rpError', rejected + ' photo(s) not added — at most ' + MobileRepair.MAX_PHOTOS + ' per repair.');
  };

  // ── Kunde ────────────────────────────────────────────────────────────────────────────────────
  function rpSetCustomer(id, name) {
    RP.customer = id ? { id: id, name: name || id } : null;
    const badge = $('rpCustomerPicked');
    badge.textContent = RP.customer ? RP.customer.name : '';
    badge.classList.toggle('hidden', !RP.customer);
  }
  $('rpCustomerSearchBtn').onclick = async () => {
    const box = $('rpCustomerResults');
    box.innerHTML = '';
    const r = await rpClient.read('customers.list', { q: $('rpCustomerSearch').value, limit: 10 });
    if (!r.ok) { rpSay('rpError', 'Customer search failed (' + r.code + ')'); return; }
    const items = (r.value && r.value.items) || [];
    if (!items.length) { box.appendChild(el('div', { class: 'hint' }, 'No customer found.')); return; }
    items.forEach((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || c.id;
      const b = el('button', { type: 'button', class: 'secondary' }, name + (c.phone ? ' · ' + c.phone : ''));
      b.onclick = () => { rpSetCustomer(c.id, name); box.innerHTML = ''; };
      box.appendChild(b);
    });
  };
  $('rpCustomerCreateBtn').onclick = async () => {
    const first = $('rpCustomerFirst').value.trim(), last = $('rpCustomerLast').value.trim();
    if (!first && !last) { rpSay('rpError', 'A new customer needs a name.'); return; }
    const key = 'customer:' + (RP.draftKey || 'draft');
    const body = { firstName: first, lastName: last };
    const phone = MobileRepair.textOrNull($('rpCustomerPhone').value);
    if (phone) body.phone = phone;
    const r = await rpClient.mutate(key, 'customers.create', body);
    if (r.kind === 'ok' && r.value && r.value.customerId) {
      rpSetCustomer(r.value.customerId, r.value.name || (first + ' ' + last).trim());
      rpSay('rpSuccess', 'Customer created.');
      $('rpCustomerFirst').value = ''; $('rpCustomerLast').value = ''; $('rpCustomerPhone').value = '';
    } else {
      rpSay('rpError', rpMessageFor(r, 'The customer was not created'));
    }
  };

  // ── Antworten in Worte ───────────────────────────────────────────────────────────────────────
  function rpMessageFor(r, what) {
    if (r.kind === 'rejected') return what + ': ' + (r.code || 'refused by the main computer') + '.';
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

  // ── Offene Vorhaben ──────────────────────────────────────────────────────────────────────────
  async function rpRenderOpen() {
    const list = await rpClient.openIntents();
    const box = $('rpOpenBox'), ul = $('rpOpenList');
    ul.innerHTML = '';
    box.classList.toggle('hidden', list.length === 0);
    list.forEach((rec) => {
      const line = el('div', { class: 'row' });
      line.appendChild(el('div', { class: 'hint' }, rec.op + ' · ' + rec.state + (rec.lastCode ? ' · ' + rec.lastCode : '')));
      const b = el('button', { type: 'button', class: 'secondary' }, 'Clarify now');
      b.onclick = async () => {
        b.disabled = true;
        const r = await rpClient.mutate(rec.key, rec.op, rec.payload, { clarify: true });
        b.disabled = false;
        if (r.kind === 'ok') rpSay('rpHomeError', '');
        else rpSay('rpHomeError', rpMessageFor(r, 'Still not settled'));
        await rpRenderOpen();
        await rpLoadList($('rpSearch').value);
      };
      line.appendChild(b);
      ul.appendChild(line);
    });
  }

  // ── Liste ────────────────────────────────────────────────────────────────────────────────────
  async function rpLoadList(q) {
    const box = $('rpList');
    box.innerHTML = '';
    const r = await rpClient.read('repairs.list', { q: q || '', limit: 25 });
    if (!r.ok) {
      rpSay('rpHomeError', r.status === 503
        ? 'The main computer is not answering right now (is LATAIF open on it?).'
        : 'Could not load repairs (' + r.code + ').');
      return;
    }
    rpSay('rpHomeError', '');
    const items = (r.value && r.value.items) || [];
    if (!items.length) { box.appendChild(el('div', { class: 'hint' }, 'No repairs found.')); return; }
    items.forEach((it) => {
      const card = el('div', { class: 'card' });
      const b = el('button', { type: 'button', class: 'secondary' },
        it.repairNumber + ' · ' + (it.itemBrand || '') + ' ' + (it.itemModel || '') + ' · ' + it.status);
      b.onclick = () => rpOpen(it.id);
      card.appendChild(b);
      box.appendChild(card);
    });
  }

  // ── Eine Reparatur oeffnen ───────────────────────────────────────────────────────────────────
  // `keepMsgs`: nach einem Speichern wird die Reparatur sofort neu geladen — die Bestaetigung darf
  // dabei NICHT verschwinden, sonst hat der Benutzer gespeichert und sieht nie, dass es geklappt hat.
  async function rpOpen(id, opts) {
    if (!opts || !opts.keepMsgs) rpClearMsgs();
    const r = await rpClient.read('repairs.get', { id: id });
    if (!r.ok) { rpSay('rpHomeError', 'Could not open the repair (' + r.code + ').'); return; }
    const rep = r.value || {};
    RP.mode = 'edit';
    RP.repair = rep;
    RP.customer = null;
    RP.slots = (rep.images || []).map((src, i) => ({ keep: i, src: src }));
    rpFillForm(rep);
    $('rpHeadline').textContent = rep.repairNumber || 'Repair';
    $('rpSubline').textContent = (rep.itemBrand || '') + ' ' + (rep.itemModel || '');
    $('rpCustomerCard').classList.add('hidden');
    $('rpDiagnosisRow').classList.remove('hidden');
    $('rpSaveBtn').textContent = 'Save Changes';
    rpRenderPhotos();
    rpRenderLines(rep);
    rpRenderStatus(rep);
    screen('formRepair');
  }

  function rpRenderLines(rep) {
    const lines = rep.lines || [];
    $('rpLinesCard').classList.toggle('hidden', lines.length === 0);
    $('rpLinesTotal').textContent = 'open ' + (rep.openLineTotal || 0);
    const box = $('rpLines');
    box.innerHTML = '';
    lines.forEach((l) => {
      box.appendChild(el('div', { class: 'hint' },
        (l.workType || 'work') + ' · ' + (l.costAmount || 0) + ' · ' + (l.status || '')));
    });
  }

  function rpRenderStatus(rep) {
    const targets = rep.allowedStatusTargets || [];
    $('rpStatusCard').classList.remove('hidden');
    $('rpStatusNow').textContent = rep.status || '';
    const row = $('rpStatusRow');
    row.innerHTML = '';
    if (!targets.length) { row.appendChild(el('div', { class: 'hint' }, 'No next step from here on a phone.')); return; }
    targets.forEach((t) => {
      const b = el('button', { type: 'button', class: 'secondary' }, 'Mark as ' + t);
      b.onclick = async () => {
        if (RP.busy) return;
        RP.busy = true; b.disabled = true;
        const key = 'status:' + rep.id + ':' + rep.revision + ':' + t;
        const r = await rpClient.mutate(key, 'repairs.update_status', {
          repairId: rep.id, status: t, expectedRevision: rep.revision,
        });
        RP.busy = false; b.disabled = false;
        if (r.kind === 'ok') { await rpOpen(rep.id, { keepMsgs: true }); rpSay('rpSuccess', 'Status is now ' + t + '.'); }
        else rpSay('rpError', rpMessageFor(r, 'The status was not changed'));
        await rpRenderOpen();
      };
      row.appendChild(b);
    });
  }

  // ── Neu erfassen ─────────────────────────────────────────────────────────────────────────────
  function rpNewIntake() {
    rpClearMsgs();
    RP.mode = 'create';
    RP.repair = null;
    RP.slots = [];
    RP.draftKey = uuid();
    rpSetCustomer(null, '');
    rpFillForm({});
    $('rpHeadline').textContent = 'New Repair Intake';
    $('rpSubline').textContent = 'Customer item handed in for repair';
    $('rpCustomerCard').classList.remove('hidden');
    $('rpCustomerResults').innerHTML = '';
    $('rpDiagnosisRow').classList.add('hidden');
    $('rpLinesCard').classList.add('hidden');
    $('rpStatusCard').classList.add('hidden');
    $('rpSaveBtn').textContent = 'Save Repair';
    rpRenderPhotos();
    screen('formRepair');
  }

  // ── Fotos in die Ablage des Primary ──────────────────────────────────────────────────────────
  //
  // Nur NEUE Fotos werden hochgeladen; gespeicherte bleiben `{keep:i}` und werden nie neu gerechnet.
  // Die Kennung ist der Hash der Bytes: dasselbe Foto zweimal hochgeladen ergibt dieselbe Kennung,
  // also entsteht bei einer Wiederholung kein zweites Bild.
  async function rpStageSlots() {
    for (const slot of RP.slots) {
      if (slot.stagingId || typeof slot.keep === 'number') continue;
      const r = await rpClient.stagePhoto(slot.dataUrl);
      if (!r.ok) return { ok: false, code: r.code };
      slot.stagingId = r.stagingId;
    }
    return { ok: true };
  }

  // ── Speichern ────────────────────────────────────────────────────────────────────────────────
  $('rpSaveBtn').onclick = async () => {
    if (RP.busy) return;
    rpClearMsgs();
    const form = rpFormValues();
    if (!MobileRepair.textOrNull(form.issueDescription)) { rpSay('rpError', 'Please describe the issue.'); return; }
    if (RP.mode === 'create' && !RP.customer) { rpSay('rpError', 'Please choose or create a customer.'); return; }
    RP.busy = true;
    $('rpSaveBtn').disabled = true;
    $('rpSaveBtn').textContent = 'Saving…';
    try {
      const staged = await rpStageSlots();
      if (!staged.ok) { rpSay('rpError', 'A photo could not be uploaded (' + staged.code + ') — nothing was saved.'); return; }
      let r;
      if (RP.mode === 'create') {
        const body = MobileRepair.createBody(
          Object.assign({}, form, { customerId: RP.customer.id }),
          RP.slots.map((s) => s.stagingId).filter(Boolean),
        );
        r = await rpClient.mutate('create:' + RP.draftKey, 'repairs.create', body);
        if (r.kind === 'ok') {
          if (r.value && r.value.repairId) await rpOpen(r.value.repairId, { keepMsgs: true });
          rpSay('rpSuccess', 'Saved as ' + ((r.value && r.value.repairNumber) || 'a new repair') + '.');
        }
      } else {
        const plan = MobileRepair.photoPlan(RP.slots);
        const body = MobileRepair.editBody(RP.repair, form, plan);
        if (!MobileRepair.editHasChanges(body)) { rpSay('rpError', 'Nothing changed.'); return; }
        const id = RP.repair.id;
        r = await rpClient.mutate('edit:' + id + ':' + RP.repair.revision, 'repairs.update', body);
        if (r.kind === 'ok') { await rpOpen(id, { keepMsgs: true }); rpSay('rpSuccess', 'Changes saved.'); }
      }
      if (r && r.kind !== 'ok') {
        rpSay('rpError', r.code === 'RECORD_CHANGED'
          ? 'Someone changed this repair in the meantime. Nothing was overwritten — open it again to see the current state.'
          : rpMessageFor(r, 'The repair was not saved'));
      }
    } catch (err) {
      // Ein Fehler beim ANZEIGEN darf nicht aussehen wie ein Fehler beim SPEICHERN — und er darf vor
      // allem nicht stumm bleiben: sonst steht der Benutzer vor einer Maske, die nichts sagt.
      try { console.error('[repair] save/refresh failed: ' + ((err && err.stack) || String(err))); } catch (e) { /* egal */ }
      rpSay('rpError', 'Saved, but this screen could not be refreshed: ' + ((err && err.message) || String(err)));
    } finally {
      RP.busy = false;
      $('rpSaveBtn').disabled = false;
      $('rpSaveBtn').textContent = RP.mode === 'create' ? 'Save Repair' : 'Save Changes';
      await rpRenderOpen();
    }
  };

  // ── AI ───────────────────────────────────────────────────────────────────────────────────────
  //
  // Sie liest das erste Foto und fuellt NUR leere beschreibende Felder. Sie speichert nichts, und
  // sie kann nichts vorschlagen, was es nicht gibt: der Primary filtert die Antwort auf genau die
  // sechs erlaubten Repair-Felder.
  $('rpAiBtn').onclick = async () => {
    if (RP.busy || !RP.slots.length) { rpSay('rpAiMsg', 'Take a photo first.', false); return; }
    const first = RP.slots[0];
    const image = first.dataUrl || first.src;
    RP.busy = true;
    $('rpAiBtn').textContent = 'Identifying…';
    rpSay('rpAiMsg', 'Reading the photo…', true);
    try {
      const res = await fetch('/api/ai/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem(TOKEN_KEY) || '') },
        body: JSON.stringify({
          kind: 'repair',
          category_id: 'repair',
          image: image,
          hints: [$('rpBrand').value, $('rpModel').value].filter(Boolean).join(' ').trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        rpSay('rpAiMsg', data.error ? String(data.error) : ('Identify failed (' + res.status + ').'), false);
      } else {
        const form = rpFormValues();
        const filled = MobileRepair.applyAiSuggestions(form, data.result || {});
        rpFillForm(form);
        rpSay('rpAiMsg', filled
          ? ('Filled ' + filled + ' empty field' + (filled === 1 ? '' : 's') + ' — please check before saving.')
          : 'Nothing new recognised — your entries are unchanged.', filled > 0);
      }
    } catch (e) {
      rpSay('rpAiMsg', 'Identify unavailable — you can still fill the form in by hand.', false);
    } finally {
      RP.busy = false;
      $('rpAiBtn').textContent = '✨  AI Identify';
    }
  };

  // ── Einstiege ────────────────────────────────────────────────────────────────────────────────
  $('rpNewBtn').onclick = rpNewIntake;
  $('rpSearchBtn').onclick = () => rpLoadList($('rpSearch').value);
  $('rpSearch').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); rpLoadList($('rpSearch').value); } };
  document.querySelectorAll('[data-back-repair]').forEach((btn) => {
    btn.onclick = () => { screen('repairHome'); rpRenderOpen(); rpLoadList($('rpSearch').value); };
  });
  async function rpHomeOpen() {
    screen('repairHome');
    rpClearMsgs();
    await rpRenderOpen();
    await rpLoadList($('rpSearch').value);
  }
