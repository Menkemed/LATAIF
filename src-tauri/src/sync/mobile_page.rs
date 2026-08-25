// Self-contained mobile capture page served at /mobile.
// Pure HTML/JS/CSS, zero build step. Works on any mobile browser in LAN.
//
// v0.4.0 — Vorfilter: nach dem Login waehlt der User EINEN von drei Modi:
//   • Collection — New Item  → legt ein Produkt an (products-Insert).
//   • Repair — New Intake    → legt Customer + Repair an (received).
//   • Purchase — Photo        → legt nur ein Foto in die purchase_inbox.
//                               Die echte Purchase macht der Owner am Desktop.

// MOBILE-04B2A9-I1 — the durable collection-upload queue module is included verbatim into the page,
// right after <script>, so it defines `window.MobileUploadQueue` before the page IIFE uses it.
pub const MOBILE_HTML: &str = concat!(r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<meta name="theme-color" content="#0B0B0D" />
<title>LATAIF Mobile</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body { background: #08080A; color: #EAEAEA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; min-height: 100vh; padding: 16px; }
  .brand { text-align: center; margin: 24px 0 28px; }
  .brand h1 { font-size: 22px; letter-spacing: 0.25em; color: #C6A36D; font-weight: 300; }
  .brand p { font-size: 11px; color: #6B6B73; letter-spacing: 0.12em; margin-top: 4px; text-transform: uppercase; }
  .card { background: #121216; border: 1px solid #1A1A1F; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  label { display: block; font-size: 11px; color: #6B6B73; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 8px; }
  input, textarea, select { width: 100%; background: #08080A; border: 1px solid #1A1A1F; border-radius: 6px; padding: 12px; color: #EAEAEA; font-size: 16px; font-family: inherit; outline: none; }
  input:focus, textarea:focus, select:focus { border-color: #C6A36D; }
  button { width: 100%; background: #C6A36D; color: #0B0B0D; border: none; border-radius: 6px; padding: 14px; font-size: 15px; font-weight: 600; cursor: pointer; letter-spacing: 0.04em; }
  button.ghost { background: transparent; color: #A1A1AA; border: 1px solid #2A2A32; }
  button:disabled { opacity: 0.4; }
  .row + .row { margin-top: 14px; }
  .error { background: rgba(170,110,110,0.1); color: #AA6E6E; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; }
  .success { background: rgba(126,170,110,0.1); color: #7EAA6E; padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; }
  .photo-area { border: 2px dashed #2A2A32; border-radius: 8px; padding: 32px 16px; text-align: center; cursor: pointer; min-height: 200px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; }
  .photo-area.has-image { padding: 0; border-style: solid; }
  .photo-area img { max-width: 100%; border-radius: 6px; display: block; }
  .photo-area .hint { color: #6B6B73; font-size: 13px; }
  .photo-strip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 2px 2px; }
  .photo-thumb { position: relative; flex: 0 0 auto; width: 78px; height: 78px; border-radius: 8px; overflow: hidden; border: 2px solid #2A2A32; background: #08080A; }
  .photo-thumb.is-primary { border-color: #C6A36D; }
  .photo-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-thumb .rm { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; line-height: 20px; padding: 0; border-radius: 999px; background: rgba(0,0,0,.72); border: 1px solid #2A2A32; color: #EAEAEA; font-size: 13px; text-align: center; }
  .photo-thumb .cover { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(198,163,109,.92); color: #14140F; font-size: 10px; letter-spacing: .06em; text-align: center; padding: 2px 0; }
  .photo-area .icon { font-size: 36px; }
  .hidden { display: none; }
  /* MOBILE-FIELDS — dynamic per-category fields */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { width: auto; flex: 0 0 auto; background: #08080A; border: 1px solid #2A2A32; color: #A1A1AA; padding: 9px 13px; border-radius: 999px; font-size: 14px; font-weight: 500; }
  .chip.on { background: rgba(198,163,109,0.16); border-color: #C6A36D; color: #EAEAEA; }
  .req { color: #C6A36D; }
  .fielderr { color: #AA6E6E; font-size: 12px; margin-top: 6px; }
  #cAttrs .row:first-child { margin-top: 14px; }
  .logout { display: block; text-align: center; color: #6B6B73; font-size: 12px; margin-top: 20px; text-decoration: none; }
  .logout:hover { color: #AA6E6E; }
  .header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .header-row .badge { background: rgba(126,170,110,0.08); color: #7EAA6E; padding: 4px 10px; border-radius: 999px; font-size: 11px; }
  /* Vorfilter mode picker */
  .mode-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left;
    background: #121216; border: 1px solid #2A2A32; color: #EAEAEA; padding: 18px 16px; font-weight: 600;
    font-size: 16px; letter-spacing: 0; margin-bottom: 12px; }
  .mode-btn span { font-size: 12px; font-weight: 400; color: #6B6B73; letter-spacing: 0; }
  .mode-btn:active { border-color: #C6A36D; }
  .back { display: inline-flex; align-items: center; gap: 4px; background: transparent; color: #A1A1AA;
    border: none; width: auto; padding: 0; font-size: 13px; font-weight: 400; margin-bottom: 4px; }
  /* Scan-Overlay: Rahmen + animierte Linie (zeigt "hier scannt's") */
  .scan-frame { position: absolute; top: 16%; bottom: 16%; left: 9%; right: 9%; border: 2px solid rgba(198,163,109,0.95);
    border-radius: 12px; box-shadow: 0 0 0 2000px rgba(0,0,0,0.30); overflow: hidden; pointer-events: none; }
  .scan-line { position: absolute; left: 0; right: 0; height: 2px; background: #C6A36D; box-shadow: 0 0 8px 1px #C6A36D;
    animation: scanmove 2.2s ease-in-out infinite; }
  @keyframes scanmove { 0% { top: 6%; } 50% { top: 94%; } 100% { top: 6%; } }
</style>
</head>
<body>

<!-- ─────────── Login ─────────── -->
<div id="login" class="hidden">
  <div class="brand">
    <h1>LATAIF</h1>
    <p>Mobile Capture</p>
  </div>
  <div class="card">
    <div id="loginError" class="error hidden"></div>
    <div class="row">
      <label>Email</label>
      <input id="email" type="email" autocomplete="email" placeholder="admin@lataif.com" />
    </div>
    <div class="row">
      <label>Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
    </div>
    <div class="row" style="margin-top: 20px;">
      <button id="loginBtn">Sign in</button>
    </div>
    <p style="color: #3D3D45; font-size: 11px; text-align: center; margin-top: 16px;">
      Default: admin@lataif.com / admin
    </p>
  </div>
</div>

<!-- ─────────── Vorfilter / Mode picker ─────────── -->
<div id="modePicker" class="hidden">
  <div class="brand">
    <h1>LATAIF</h1>
    <p>Mobile Capture</p>
  </div>
  <div class="card">
    <label style="margin-bottom: 14px;">What are you capturing?</label>
    <button class="mode-btn" data-mode="collection">📦&nbsp; New Collection Item<span>Add a product to inventory</span></button>
    <button class="mode-btn" data-mode="repair">🔧&nbsp; New Repair Intake<span>Customer item handed in for repair</span></button>
    <button class="mode-btn" data-mode="purchase">🛒&nbsp; Purchase Photo<span>Snap the item — finish the purchase on desktop</span></button>
    <button class="mode-btn" data-mode="scan">🔍&nbsp; Check Item<span>Scan a tag — see full product details</span></button>
  </div>
  <a href="#" class="logout" id="logoutLink">Sign out</a>
</div>

<!-- ─────────── Collection — New Item ─────────── -->
<div id="formCollection" class="hidden">
  <button class="back" data-back>‹ Back</button>
  <div class="brand" style="margin-top: 4px;">
    <h1>LATAIF</h1>
    <p>New Collection Item</p>
  </div>

  <div id="cError" class="error hidden"></div>
  <div id="cSuccess" class="success hidden"></div>

  <div class="card">
    <div class="header-row">
      <span style="font-size: 13px; color: #A1A1AA;">Photos</span>
      <span id="cPhotoStatus" class="badge hidden">Captured</span>
    </div>
    <!-- MOBILE-MULTI-IMAGE §3 — a product may carry several photos. The upload contract and the
         desktop ingest have always accepted an ordered batch (slots 0..N-1, primary = slot 0); only
         this capture UI held it to one. The strip below IS that order: the first thumbnail is the
         cover, and tapping another one promotes it. -->
    <label for="cPhotoInput" class="photo-area" id="cPhotoArea">
      <div class="icon">📷</div>
      <div>Tap to take photos</div>
      <div class="hint">or choose from gallery — several at once</div>
    </label>
    <div id="cPhotoStrip" class="photo-strip hidden"></div>
    <div id="cPhotoHint" class="hidden" style="color:#6B6B73; font-size:12px; margin-top:8px; line-height:1.5;">
      First photo is the cover. Tap a photo to make it the cover, ✕ to remove it.
    </div>
    <input id="cPhotoInput" class="hidden" type="file" accept="image/*" capture="environment" multiple />
    <!-- MOBILE-I1C §4 — identification is a SUGGESTION step. It fills empty fields from the photo
         and is only offered once a photo exists; the photo, the quantity and anything already typed
         are never touched by it. -->
    <button id="cAiBtn" class="ghost hidden" style="margin-top:12px;">✨&nbsp; AI Identify</button>
    <div id="cAiMsg" style="font-size:12px; margin-top:8px;"></div>
  </div>

  <div class="card">
    <div class="row">
      <label>Category *</label>
      <select id="cCategory"></select>
    </div>
    <div class="row" id="cBrandRow">
      <label id="cBrandLabel">Brand</label>
      <input id="cBrand" type="text" placeholder="e.g. Rolex" />
    </div>
    <div class="row" id="cNameRow">
      <label id="cNameLabel">Model / Name</label>
      <input id="cName" type="text" placeholder="e.g. Submariner Date" />
    </div>
    <div class="row">
      <label>SKU / Reference</label>
      <input id="cSku" type="text" placeholder="optional" />
    </div>
    <!-- MOBILE-QUANTITY — how many identical pieces this capture represents. Defaults to 1, which is
         what nearly every capture is, so the normal user never touches it. `inputmode=numeric` gives a
         digits-only keypad; the value is validated here AND independently by the server. -->
    <div class="row">
      <label>Quantity</label>
      <input id="cQuantity" type="number" inputmode="numeric" min="1" step="1" value="1" />
    </div>
    <div class="row" id="cConditionRow">
      <label>Condition</label>
      <select id="cCondition"></select>
    </div>
    <!-- MOBILE-FIELDS — category-specific fields rendered here from the desktop SSOT schema. -->
    <div id="cAttrs"></div>
    <div class="row hidden" id="cScopeRow">
      <label>Included</label>
      <div id="cScope" class="chips"></div>
    </div>
    <!-- MOBILE-PRICING — the three canonical product prices (all optional, all categories). Text +
         inputmode=decimal so we own comma/dot normalisation; the server (v2) is the authority. -->
    <div class="row">
      <label>Purchase Price (BHD)</label>
      <input id="cPurchasePrice" type="text" inputmode="decimal" placeholder="optional" />
    </div>
    <div class="row">
      <label>Sale Price (BHD)</label>
      <input id="cSalePrice" type="text" inputmode="decimal" placeholder="optional" />
    </div>
    <div class="row">
      <label>Min Sale Price (BHD)</label>
      <input id="cMinSalePrice" type="text" inputmode="decimal" placeholder="optional" />
    </div>
  </div>

  <button id="cSaveBtn">Save Product</button>
  <div id="cPending" class="hidden" style="margin-top:12px;padding:10px;border:1px solid #2A2A30;border-radius:8px;background:#111;">
    <div id="cPendingText" style="font-size:13px;color:#BDBDBD;margin-bottom:8px;"></div>
    <button id="cRetryPending" class="hidden" style="width:100%;">Retry pending uploads</button>
  </div>
</div>

<!-- ─────────── Repair — New Intake ─────────── -->
<div id="formRepair" class="hidden">
  <button class="back" data-back>‹ Back</button>
  <div class="brand" style="margin-top: 4px;">
    <h1>LATAIF</h1>
    <p>New Repair Intake</p>
  </div>

  <div id="rError" class="error hidden"></div>
  <div id="rSuccess" class="success hidden"></div>

  <div class="card">
    <div class="header-row">
      <span style="font-size: 13px; color: #A1A1AA;">Item Photo</span>
      <span id="rPhotoStatus" class="badge hidden">Captured</span>
    </div>
    <label for="rPhotoInput" class="photo-area" id="rPhotoArea">
      <div class="icon">📷</div>
      <div>Tap to take photo</div>
      <div class="hint">photograph the item at intake</div>
    </label>
    <input id="rPhotoInput" class="hidden" type="file" accept="image/*" capture="environment" />
  </div>

  <div class="card">
    <div class="row">
      <label>Customer Name *</label>
      <input id="rCustomer" type="text" placeholder="e.g. Ahmed Al-Khalifa" />
    </div>
    <div class="row">
      <label>Item Brand</label>
      <input id="rBrand" type="text" placeholder="e.g. Rolex (optional)" />
    </div>
    <div class="row">
      <label>Item Model</label>
      <input id="rModel" type="text" placeholder="e.g. Datejust (optional)" />
    </div>
    <div class="row">
      <label>Issue / Problem *</label>
      <textarea id="rIssue" rows="3" placeholder="What needs to be repaired?"></textarea>
    </div>
    <div class="row">
      <label>Notes</label>
      <textarea id="rNotes" rows="2" placeholder="Optional"></textarea>
    </div>
  </div>

  <button id="rSaveBtn">Save Repair Intake</button>
</div>

<!-- ─────────── Purchase — Photo to Inbox ─────────── -->
<div id="formPurchase" class="hidden">
  <button class="back" data-back>‹ Back</button>
  <div class="brand" style="margin-top: 4px;">
    <h1>LATAIF</h1>
    <p>Purchase Photo</p>
  </div>

  <div id="bError" class="error hidden"></div>
  <div id="bSuccess" class="success hidden"></div>

  <div class="card">
    <div class="header-row">
      <span style="font-size: 13px; color: #A1A1AA;">Item Photo *</span>
      <span id="bPhotoStatus" class="badge hidden">Captured</span>
    </div>
    <label for="bPhotoInput" class="photo-area" id="bPhotoArea">
      <div class="icon">📷</div>
      <div>Tap to take photo</div>
      <div class="hint">snap the item you bought</div>
    </label>
    <input id="bPhotoInput" class="hidden" type="file" accept="image/*" capture="environment" />
  </div>

  <div class="card">
    <div class="row">
      <label>Note</label>
      <textarea id="bNote" rows="3" placeholder="Supplier, price, anything to remember (optional)"></textarea>
    </div>
    <p style="color: #6B6B73; font-size: 12px; margin-top: 12px; line-height: 1.5;">
      The photo lands in the <strong style="color:#A1A1AA;">Purchase Inbox</strong> on the desktop.
      Open it there to create the purchase — supplier, items, payment — with AI&nbsp;identify.
    </p>
  </div>

  <button id="bSaveBtn">Send to Purchase Inbox</button>
</div>

<!-- ─────────── Live Barcode Scanner (Test) ─────────── -->
<div id="scanScreen" class="hidden">
  <button class="back" data-back>‹ Back</button>
  <div class="brand" style="margin-top: 4px;">
    <h1>LATAIF</h1>
    <p>Check Item</p>
  </div>
  <div id="scanMsg" class="error hidden"></div>

  <!-- MOBILE-I1 §11 — two ways to reach the SAME product view. The scanner is unchanged; search is
       simply a second way in, for the items whose tag is missing, unreadable or still in the safe. -->
  <div id="findTabs" style="display:flex; gap:8px; margin-bottom:12px;">
    <button id="tabScan" class="ghost" style="flex:1;">Scan tag</button>
    <button id="tabSearch" class="ghost" style="flex:1;">Search</button>
  </div>

  <div id="searchPane" class="hidden">
    <div class="card" style="padding:12px;">
      <input id="searchInput" type="search" inputmode="search" autocomplete="off"
             placeholder="SKU, serial, reference, brand or name"
             style="width:100%; box-sizing:border-box;" />
      <div id="searchHint" style="color:#6B6B73; font-size:12px; margin-top:8px;">
        Type at least two characters. Partial numbers work.
      </div>
    </div>
    <div id="searchResults"></div>
  </div>

  <div id="scanPane">
    <div class="card" style="padding: 0; overflow: hidden; position: relative;">
      <video id="scanVideo" playsinline muted style="width:100%; display:block; background:#000; aspect-ratio:3/4; object-fit:cover;"></video>
      <div class="scan-frame"><div class="scan-line"></div></div>
    </div>
    <p style="color:#6B6B73; font-size:12px; margin-top:8px; line-height:1.5;">
      Hold a printed tag in front of the rear camera. Camera access needs HTTPS or localhost.
    </p>
  </div>

  <div id="scanResult" class="card hidden">
    <div id="scanValue" style="font-size:12px; color:#6B6B73; font-family:monospace; text-align:center; margin-bottom:10px; word-break:break-all;"></div>
    <div id="scanDetails"></div>
    <button id="scanAgainBtn" class="ghost" style="margin-top:16px;">Scan again</button>
  </div>
</div>

<script>
window.__MOBILE_FIELD_SCHEMA__ = "##, include_str!("mobile_field_schema.json"), r##";
"##, include_str!("mobile_upload_queue.js"), r##"
(function () {
  const TOKEN_KEY = 'lataif_mobile_token';
  const BRANCH_KEY = 'lataif_mobile_branch';
  const USER_KEY = 'lataif_mobile_user';

  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const setText = (id, t) => { const el = $(id); el.textContent = t; if (t) el.classList.remove('hidden'); else el.classList.add('hidden'); };

  const SCREENS = ['login', 'modePicker', 'formCollection', 'formRepair', 'formPurchase', 'scanScreen'];
  function screen(id) { SCREENS.forEach(s => hide(s)); show(id); window.scrollTo({ top: 0 }); }

  // Foto-State pro Modus.
  const photos = { collection: null, repair: null, purchase: null };

  // Secure UUID v4 for upload/entity ids. crypto.randomUUID exists on secure origins (HTTPS, and localhost);
  // on a plain-HTTP LAN origin (phone → http://<ip>:3001/mobile) it is undefined, so we fall back to
  // crypto.getRandomValues, which is available in EVERY context. We NEVER fall back to Math.random — an
  // upload id must not come from a weak, predictable source, so this fails closed if no CSPRNG exists.
  function uuid() {
    const c = (typeof crypto !== 'undefined' && crypto) || (typeof self !== 'undefined' && self.crypto) || null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
      const b = new Uint8Array(16);
      c.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; // version 4
      b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
      let s = '';
      for (let i = 0; i < 16; i++) {
        if (i === 4 || i === 6 || i === 8 || i === 10) s += '-';
        s += (b[i] + 0x100).toString(16).slice(1);
      }
      return s;
    }
    throw new Error('No secure random source available for upload id');
  }

  // ── MOBILE-04B2A9 — durable collection upload queue (IndexedDB; image bytes NEVER in localStorage) ──
  const UP_DB = 'lataif_mobile_uploads', UP_STORE = 'collectionUploads';
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(UP_DB, 1);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(UP_STORE)) db.createObjectStore(UP_STORE, { keyPath: 'uploadEventId' }); };
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  const idbReq = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const idbStore = {
    async get(id) { const db = await idbOpen(); return idbReq(db.transaction(UP_STORE, 'readonly').objectStore(UP_STORE).get(id)); },
    async put(e) { const db = await idbOpen(); return idbReq(db.transaction(UP_STORE, 'readwrite').objectStore(UP_STORE).put(e)); },
    async delete(id) { const db = await idbOpen(); return idbReq(db.transaction(UP_STORE, 'readwrite').objectStore(UP_STORE).delete(id)); },
    async getAll() { const db = await idbOpen(); return idbReq(db.transaction(UP_STORE, 'readonly').objectStore(UP_STORE).getAll()); },
  };
  const uploadQueue = MobileUploadQueue.createQueue({
    store: idbStore, fetchFn: (u, o) => fetch(u, o), genId: uuid, now: () => new Date().toISOString(),
  });
  // The queue is drained ONLY after login + an explicit user trigger (a Save click or the "Retry pending"
  // button) — never automatically on load.
  async function updatePending() {
    try {
      const all = await idbStore.getAll();
      const active = all.filter((e) => e.state !== 'conflict' && e.state !== 'rejected');
      const stuck = all.filter((e) => e.state === 'conflict' || e.state === 'rejected');
      const el = $('cPending'); if (!el) return;
      if (active.length + stuck.length === 0) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      let msg = '';
      if (active.length) msg += active.length + ' upload(s) pending. ';
      if (stuck.length) msg += stuck.length + ' need attention. ';
      setText('cPendingText', msg.trim());
      $('cRetryPending').classList.toggle('hidden', active.length === 0);
    } catch (_) { /* IndexedDB unavailable → the queue simply does not surface, never throws */ }
  }
  async function drainPending() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { init(); return; }
    $('cRetryPending').disabled = true;
    try { await uploadQueue.drainAll(token); } catch (_) {}
    $('cRetryPending').disabled = false;
    await updatePending();
  }

  function init() {
    if (localStorage.getItem(TOKEN_KEY)) { screen('modePicker'); onSignedIn(); }
    else screen('login');
  }
  // After a (re)login: recover a crash-interrupted `sending` to retryable and surface any pending uploads.
  // Does NOT auto-drain — the user triggers a resend.
  async function onSignedIn() {
    try { await uploadQueue.recoverStaleSending(); } catch (_) {}
    await updatePending();
  }

  // ── Login ──
  $('loginBtn').onclick = async () => {
    setText('loginError', '');
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email || !password) return setText('loginError', 'Email and password required.');
    $('loginBtn').disabled = true;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error('Invalid credentials');
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(BRANCH_KEY, data.branch_id || 'branch-main');
      if (data.user_id) localStorage.setItem(USER_KEY, data.user_id);
      screen('modePicker');
      onSignedIn();
    } catch (e) {
      setText('loginError', e.message || 'Login failed');
    }
    $('loginBtn').disabled = false;
  };

  $('logoutLink').onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(BRANCH_KEY);
    localStorage.removeItem(USER_KEY);
    init();
  };

  // ── Vorfilter: Modus waehlen ──
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.onclick = () => {
      const mode = btn.getAttribute('data-mode');
      if (mode === 'collection') screen('formCollection');
      else if (mode === 'repair') screen('formRepair');
      else if (mode === 'purchase') screen('formPurchase');
      else if (mode === 'scan') { screen('scanScreen'); findMode('scan'); }
    };
  });
  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.onclick = () => { stopScan(); screen('modePicker'); };
  });

  // ── Live Barcode Scanner (zxing-wasm) ──
  // Kamera braucht "secure context" (HTTPS oder localhost). Dekodiert per zxing-wasm
  // (WebAssembly — zuverlaessiger als JS-ZXing, auch auf iOS Safari). Eigener Frame-Loop:
  // Video -> Canvas -> ImageData -> readBarcodesFromImageData.
  let scanStream = null, scanRunning = false, scanBusy = false, scanCanvas = null, wasmConfigured = false;
  function loadWasm() {
    return new Promise((resolve, reject) => {
      if (window.ZXingWASM) return resolve();
      const s = document.createElement('script');
      s.src = '/zxing-wasm.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('could not load /zxing-wasm.js'));
      document.head.appendChild(s);
    });
  }
  async function startScan() {
    setText('scanMsg', '');
    hide('scanResult');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // Ueber HTTP (Handy im LAN) sperrt der Browser die Kamera — auf die HTTPS-Seite bruecken.
      if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        $('scanMsg').innerHTML = 'The camera needs a secure connection. <a href="https://' + location.hostname + ':3443/mobile" style="color:#C6A36D; font-weight:600; text-decoration:underline;">Tap to open the secure (HTTPS) page</a>, accept the certificate warning once, then Check Item again.';
        $('scanMsg').classList.remove('hidden');
        return;
      }
      return setText('scanMsg', 'Camera unavailable in this browser.');
    }
    try {
      setText('scanMsg', 'Starting camera...');
      await loadWasm();
      if (!wasmConfigured) {
        ZXingWASM.setZXingModuleOverrides({ locateFile: (path, prefix) => (typeof path === 'string' && path.endsWith('.wasm')) ? '/zxing_reader.wasm' : ((prefix || '') + path) });
        wasmConfigured = true;
      }
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } });
      const v = $('scanVideo');
      v.srcObject = scanStream;
      await v.play();
      scanCanvas = document.createElement('canvas');
      scanRunning = true;
      setText('scanMsg', '');
      scanLoop();
    } catch (e) {
      setText('scanMsg', 'Scanner could not start: ' + (e && e.message ? e.message : e));
    }
  }
  async function scanLoop() {
    if (!scanRunning) return;
    const v = $('scanVideo');
    if (!scanBusy && v && v.videoWidth > 0) {
      scanBusy = true;
      try {
        const w = v.videoWidth, h = v.videoHeight;
        scanCanvas.width = w; scanCanvas.height = h;
        const ctx = scanCanvas.getContext('2d');
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const results = await ZXingWASM.readBarcodesFromImageData(img, {
          tryHarder: true,
          formats: ['QRCode', 'Code128', 'EAN-13', 'UPC-A', 'Code39', 'DataMatrix'],
          maxNumberOfSymbols: 1,
        });
        if (scanRunning && results && results.length && results[0].text) {
          scanBusy = false;
          onScan(results[0].text);
          return;
        }
      } catch (_) { /* keep trying */ }
      scanBusy = false;
    }
    setTimeout(scanLoop, 180);
  }
  function onScan(value) {
    scanRunning = false;
    stopScan();
    if (navigator.vibrate) navigator.vibrate(80);
    $('scanValue').textContent = value;
    $('scanDetails').innerHTML = 'Looking up…';
    show('scanResult');
    lookupProduct(value);
  }
  async function lookupProduct(sku) {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch('/api/products/by-sku/' + encodeURIComponent(sku), { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 404) { $('scanDetails').innerHTML = '<div style="color:#AA6E6E; text-align:center;">No product found for this SKU.</div>'; return; }
      if (!res.ok) { $('scanDetails').textContent = 'Lookup failed (' + res.status + ').'; return; }
      // §32 — the scanner renders through the SAME showProduct the search hits use. No origin:
      // a scan is not a search, so it gets no back control and leaves any search state alone.
      showProduct(await res.json());
    } catch (e) {
      $('scanDetails').textContent = 'Lookup error: ' + (e && e.message ? e.message : e);
    }
  }

  // MOBILE-I1 §11 — switch between the two ways of finding an item. The camera is stopped whenever
  // it is not visible: leaving it running behind a search pane drains the battery and keeps the
  // recording indicator on for no reason.
  function findMode(mode) {
    const searching = mode === 'search';
    searchReturn = null;   // §B3 — a tab switch is not "back"; never leave a stale target behind
    if (searching) stopScan();
    hide('scanResult');
    releaseMedia();
    if (searching) { show('searchPane'); hide('scanPane'); } else { hide('searchPane'); show('scanPane'); }
    const on = { background: '#C6A36D', color: '#141418', borderColor: '#C6A36D' };
    const off = { background: 'transparent', color: '#EAEAEA', borderColor: '#2A2A32' };
    Object.assign($('tabScan').style, searching ? off : on);
    Object.assign($('tabSearch').style, searching ? on : off);
    setText('scanMsg', '');
    if (searching) { const i = $('searchInput'); if (i) i.focus(); } else { startScan(); }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  function fmtPrice(v) { const n = Number(v); return (v != null && v !== '' && Number.isFinite(n)) ? 'BD ' + n.toLocaleString('en-US') : ''; }
  // Spec-Felder: feste Anzeige-Reihenfolge (User-Wunsch). 'description' wird immer ans
  // Ende gehaengt; nicht gelistete Keys folgen davor. HIDE = entfernte/interne Felder
  // (diamonds + movement gibt es nicht mehr; Bild-Hilfsfelder nie zeigen).
  const ATTR_HIDE = new Set(['diamonds','diamond','movement','image_hash','image_embedding','image_description']);
  const ATTR_ORDER = ['reference_number','serial_number','model_number','item_type','part_type','dial','bezel','material','case_material','karat','karat_color','case_diameter_mm','case_size','size','weight','diamond_weight','original_or_copy','certificate','strap_type','color','box','papers','year','included','description'];
  const ATTR_LABEL = { reference_number:'Ref', serial_number:'Serial', model_number:'Model', case_diameter_mm:'Case Size', karat_color:'Karat Color', diamond_weight:'Diamond Ct', original_or_copy:'Original/Copy', item_type:'Item Type' };
  function prettyAttr(k) { return ATTR_LABEL[k] || k.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase()); }
  // MOBILE-I1 — load a gallery image through the authenticated media route.
  //
  // `<img src>` cannot carry an Authorization header, and putting the token in the URL would leak
  // it into logs and history. So the bytes are fetched with the header and handed to the element as
  // an object URL. Since the v0.8.37 media migration this is the ONLY way a product photo can be
  // shown at all: `products.images` is `[]` for every product now, the bytes live in the media store.
  const mediaUrls = [];
  async function paintMedia(el, key) {
    if (!el || !key) return;
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch('/api/media?key=' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      mediaUrls.push(url);
      el.src = url;
      el.style.display = 'block';
    } catch (_) { /* a missing photo must never break the details */ }
  }
  function releaseMedia() {
    while (mediaUrls.length) { try { URL.revokeObjectURL(mediaUrls.pop()); } catch (_) {} }
  }

  function renderProduct(p) {
    let attrs = {};
    try { attrs = typeof p.attributes === 'string' ? JSON.parse(p.attributes) : (p.attributes || {}); } catch (_) {}
    const rows = [];
    const add = (label, val) => { if (val !== undefined && val !== null && val !== '') rows.push('<div style="display:flex; justify-content:space-between; gap:14px; padding:7px 0; border-top:1px solid #1A1A1F;"><span style="color:#6B6B73;">' + esc(label) + '</span><span style="text-align:right; color:#EAEAEA;">' + esc(val) + '</span></div>'); };
    let html = '';
    // 1) Foto ganz oben — Galerie (media store) zuerst, Legacy-Inline als Fallback fuer alte Daten.
    let imgs = [];
    try { imgs = typeof p.images === 'string' ? JSON.parse(p.images) : (p.images || []); } catch (_) {}
    const img0 = (imgs && imgs.length) ? String(imgs[0] || '') : '';
    // MOBILE-EDIT-S1 — ALLE Fotos, nicht nur das Titelbild. Der Read-Vertrag liefert die geordnete
    // Galerie mit stabilen Identitaeten; hier wird sie sichtbar. Das grosse Bild bleibt das
    // Titelbild (`image_key`), darunter steht der Rest in Galerie-Reihenfolge. Rein anzeigend.
    const gal = Array.isArray(p.gallery) ? p.gallery : [];
    if (p.image_key) {
      html += '<img id="pdPhoto" alt="" style="width:100%; border-radius:8px; margin-bottom:14px; display:none;" />';
      if (gal.length > 1) {
        html += '<div id="pdGallery" class="photo-strip" style="margin-bottom:14px;">'
          + gal.map(function (g, i) {
              return '<div class="photo-thumb' + (g.is_primary ? ' is-primary' : '') + '" data-gi="' + i + '">'
                + '<img alt="" style="display:none;" />'
                + (g.is_primary ? '<div class="cover">COVER</div>' : '')
                + '</div>';
            }).join('')
          + '</div>';
      }
    } else if (/^(data:|https?:)/.test(img0)) {
      html += '<img src="' + esc(img0) + '" onerror="this.style.display=\'none\'" style="width:100%; border-radius:8px; margin-bottom:14px;" />';
    }
    // 2) Marke + Name
    if (p.brand) html += '<div style="font-size:11px; color:#6B6B73; letter-spacing:.08em; text-transform:uppercase;">' + esc(p.brand) + '</div>';
    html += '<div style="font-size:20px; font-weight:600; color:#EAEAEA; margin:2px 0;">' + esc(p.name || '—') + '</div>';
    // 3) Sale Price (prominent)
    const sale = fmtPrice(p.planned_sale_price);
    if (sale) html += '<div style="font-size:11px; color:#6B6B73; letter-spacing:.06em; text-transform:uppercase;">Sale Price</div><div style="font-size:22px; font-weight:600; color:#C6A36D; margin-bottom:8px;">' + sale + '</div>';
    // 4) Min Sale, dann Cost (User-Reihenfolge)
    add('Min Sale Price', fmtPrice(p.min_sale_price));
    add('Cost Price', fmtPrice(p.purchase_price));
    // 5) Stammdaten
    add('SKU', p.sku);
    add('Category', p.category_name || p.category_id);
    add('Condition', p.condition);
    add('Status', (p.stock_status || '').replace(/_/g, ' '));
    add('Location', p.storage_location);
    // v0.8.49 — was sich vom Handy bearbeiten laesst, muss hier auch wiederzufinden sein.
    // Lieferumfang und Notiz fehlten in dieser Ansicht vollstaendig: man konnte sie aendern,
    // bekam "Saved.", und sah danach nirgends, dass es angekommen war.
    let scope = [];
    try { scope = typeof p.scope_of_delivery === 'string' ? JSON.parse(p.scope_of_delivery || '[]') : (p.scope_of_delivery || []); } catch (_) {}
    add('Included', Array.isArray(scope) ? scope.join(', ') : '');
    // 6) Specs in fester Reihenfolge; diamonds/movement raus; description zuletzt
    const keys = Object.keys(attrs).filter(k => !ATTR_HIDE.has(k) && attrs[k] != null && attrs[k] !== '');
    const ordered = [];
    for (const k of ATTR_ORDER) if (k !== 'description' && keys.indexOf(k) !== -1) ordered.push(k);
    for (const k of keys) if (k !== 'description' && ATTR_ORDER.indexOf(k) === -1) ordered.push(k);
    if (keys.indexOf('description') !== -1) ordered.push('description');
    ordered.forEach(k => { let v = attrs[k]; if (typeof v === 'boolean') v = v ? 'Yes' : 'No'; add(prettyAttr(k), v); });
    add('Notes', p.notes);
    html += rows.join('');

    // MOBILE-I1 §16 — the stock-check block is ADDED to the existing details, never replaces them.
    // It is only offered when the product has an id (i.e. it came from the business database, which
    // is the only source that can be checked against).
    // MOBILE-EDIT-S2 — Textfelder eines BESTEHENDEN Artikels aendern.
    //
    // Bewusst eng: Name, Marke, Zustand, Lagerort und Notiz. Kein SKU (der wird nie nachtraeglich
    // veraendert), keine Preise, keine Kategorie, keine Attribute — und vor allem NICHTS an der
    // Galerie. Der Save schickt ausschliesslich die Felder, die der Benutzer wirklich geaendert
    // hat; nicht angefasste Felder tauchen im Payload gar nicht erst auf und koennen dadurch auch
    // nicht mit leer/null ueberschrieben werden.
    // v0.8.48 §5/§6 — bearbeitet wird nur, was verlaesslich frisch gelesen wurde. Kam der Artikel
    // aus dem Cache (Refresh gescheitert) oder liess sich seine Galerie nicht lesen, koennten auch
    // Name, Attribute, Lieferumfang und Preise veraltet sein — dann gibt es hier keinen Edit,
    // sondern eine Meldung und einen Knopf zum erneuten Laden.
    const editable = p.id && currentReadState === 'fresh' && p.gallery_ok === true;
    if (p.id && !editable) {
      html += ''
        + '<div style="margin-top:18px; padding-top:14px; border-top:1px solid #2A2A32;">'
        + '<div style="font-size:11px; color:#6B6B73; letter-spacing:.08em; text-transform:uppercase; margin-bottom:8px;">Edit</div>'
        + '<div style="color:#AA6E6E; font-size:13px; line-height:1.5; margin-bottom:10px;">Could not refresh this item. Editing is disabled so nothing is saved against an outdated view.</div>'
        + '<button id="pdRetryRead" class="ghost" style="width:100%;">Retry</button>'
        + '</div>';
    }
    if (editable) {
      html += ''
        + '<div style="margin-top:18px; padding-top:14px; border-top:1px solid #2A2A32;">'
        + '<div style="font-size:11px; color:#6B6B73; letter-spacing:.08em; text-transform:uppercase; margin-bottom:8px;">Edit</div>'
        + '<button id="pdEditBtn" class="ghost" style="width:100%;">Edit item</button>'
        + '<div id="pdEditForm" class="hidden" style="margin-top:12px;">'
        +   '<div class="row"><label>Model / Name</label><input id="peName" type="text" maxlength="200" /></div>'
        +   '<div class="row"><label>Brand</label><input id="peBrand" type="text" maxlength="120" /></div>'
        +   '<div class="row"><label>Condition</label><select id="peCondition"></select></div>'
        +   '<div class="row"><label>Location</label><input id="peLocation" type="text" maxlength="120" /></div>'
        +   '<div class="row"><label>Notes</label><input id="peNotes" type="text" maxlength="500" /></div>'
        // v0.8.48 — die Kategorieattribute und der Lieferumfang kommen aus DERSELBEN Definition wie
        // beim Anlegen; hier steht nur die Huelle, gefuellt wird sie zur Laufzeit.
        +   '<div id="peAttrs"></div>'
        +   '<div class="row hidden" id="peScopeRow"><label>Included</label><div id="peScope" class="chips"></div></div>'
        // Die Preise sind IMMER sichtbar. Darf der Artikel sie nicht mehr aendern, stehen sie
        // gesperrt da — mit dem aktuellen Wert und dem Grund daneben. Ein Feld, das einfach fehlt,
        // erklaert nichts; eines, das sichtbar gesperrt ist, schon. Verbindlich entscheidet die
        // Sperre weiterhin der Desktop beim Anwenden — das hier ist reine Anzeige.
        +   '<div id="pePrices">'
        +     '<div id="pePriceLock" class="hidden" style="color:#C8A96A; font-size:12px; line-height:1.5; margin:12px 0 2px;"></div>'
        +     '<div class="row"><label>Purchase price (BHD)</label><input id="pePurchasePrice" type="number" inputmode="decimal" step="any" min="0" /></div>'
        +     '<div class="row"><label>Sale price (BHD)</label><input id="peSalePrice" type="number" inputmode="decimal" step="any" min="0" /></div>'
        +     '<div class="row"><label>Minimum sale price (BHD)</label><input id="peMinSalePrice" type="number" inputmode="decimal" step="any" min="0" /></div>'
        +   '</div>'
        // MOBILE-EDIT-S3 — die Galerie desselben Artikels. Der Streifen IST der Endzustand: die
        // Reihenfolge, die hier steht, wird gespeichert, und das erste Bild ist das Titelbild.
        // Bestehende Bilder verschwinden NIE dadurch, dass sie hier fehlen — nur ein ausdrueckliches
        // ✕ markiert eines zum Entfernen, und das bleibt bis zum Speichern sichtbar.
        +   '<div style="font-size:11px; color:#6B6B73; letter-spacing:.08em; text-transform:uppercase; margin:14px 0 6px;">Photos</div>'
        +   '<div id="peGalleryError" class="hidden" style="color:#AA6E6E; font-size:12px; line-height:1.5; margin-bottom:8px;"></div>'
        +   '<div id="peGalleryBox">'
        +     '<div id="peStrip" class="photo-strip"></div>'
        +     '<label for="peAddInput" class="photo-area" id="peAddArea" style="margin-top:8px;">'
        +       '<div class="icon">📷</div><div>Add photos</div><div class="hint" id="peAddHint"></div>'
        +     '</label>'
        +     '<input id="peAddInput" class="hidden" type="file" accept="image/*" capture="environment" multiple />'
        +     '<div style="color:#6B6B73; font-size:12px; margin-top:6px; line-height:1.5;">First photo is the cover. Tap a photo to make it the cover, ‹ moves it left, ✕ removes it.</div>'
        +   '</div>'
        +   '<div style="display:flex; gap:8px; margin-top:12px;">'
        +     '<button id="peCancel" class="ghost" style="flex:1;">Cancel</button>'
        +     '<button id="peSave" style="flex:1;">Save changes</button>'
        +   '</div>'
        +   '<div id="peMsg" style="font-size:12px; margin-top:8px;"></div>'
        +   '<div style="color:#6B6B73; font-size:12px; margin-top:8px; line-height:1.5;">SKU and prices are not changed here.</div>'
        + '</div>'
        + '</div>';
      html += ''
        + '<div style="margin-top:18px; padding-top:14px; border-top:1px solid #2A2A32;">'
        + '<div style="font-size:11px; color:#6B6B73; letter-spacing:.08em; text-transform:uppercase; margin-bottom:8px;">Stock check</div>'
        + '<div id="scLatest" style="font-size:13px; color:#6B6B73; margin-bottom:10px;">Loading…</div>'
        + '<div style="display:flex; gap:8px; margin-bottom:8px;">'
        +   '<button id="scAvail" class="ghost" style="flex:1;">Available</button>'
        +   '<button id="scMissing" class="ghost" style="flex:1;">Not available</button>'
        + '</div>'
        + '<input id="scNotes" type="text" maxlength="500" placeholder="Notes (optional) — e.g. in safe, with customer" style="width:100%; box-sizing:border-box;" />'
        + '<div id="scMsg" style="font-size:12px; margin-top:8px;"></div>'
        + '<div id="scHistory" style="margin-top:12px;"></div>'
        + '</div>';
    }
    return html;
  }

  // ── MOBILE-I1 — ONE product view, reached from the scanner and from search alike (§10/§32) ──
  //
  // Both callers land here, so a searched product cannot drift into a different, thinner rendering
  // than a scanned one. Everything below only ADDS behaviour to the markup renderProduct produced.
  let currentProduct = null;
  let currentReadState = 'fresh';
  // Woher der gerade gezeigte Artikel geoeffnet wurde — damit ein Neuzeichnen denselben
  // Zurueck-Weg behaelt, den der Benutzer hatte.
  let currentOrigin = 'scan';
  // POST-V0838 §B — where the open came from. A search hit remembers enough to put the operator
  // back exactly where they were; a QR scan deliberately remembers nothing, so scanning never
  // fabricates a search history to go "back" to.
  let searchReturn = null;
  let lastHits = [];
  // `readState`: 'fresh' = eben vom Server gelesen, 'stale' = nur der zwischengespeicherte Treffer.
  // Nur ein frisch gelesener Artikel darf bearbeitet werden — sonst waeren nicht nur die Bilder,
  // sondern auch Name, Attribute, Lieferumfang und Preise moeglicherweise veraltet.
  function showProduct(p, origin, readState) {
    releaseMedia();
    currentProduct = p;
    currentReadState = readState || 'fresh';
    currentOrigin = origin || 'scan';
    const back = origin === 'search'
      ? '<button id="pdBack" class="ghost" style="margin-bottom:12px; padding:8px 12px;">&larr; Back to search</button>'
      : '';
    $('scanDetails').innerHTML = back + renderProduct(p);
    show('scanResult');
    window.scrollTo({ top: 0 });
    const b = $('pdBack');
    if (b) b.onclick = backToSearch;
    if (p.image_key) paintMedia($('pdPhoto'), p.image_key);
    // Jede Galerie-Kachel bekommt ihr eigenes Bild — bevorzugt das Thumbnail, sonst das Original.
    // Ein fehlendes Einzelbild darf die Detailansicht nie kippen (paintMedia schluckt das bereits).
    const galEls = document.querySelectorAll('#pdGallery .photo-thumb');
    const gal = Array.isArray(p.gallery) ? p.gallery : [];
    for (let i = 0; i < galEls.length && i < gal.length; i++) {
      paintMedia(galEls[i].querySelector('img'), gal[i].thumb_key || gal[i].image_key);
    }
    if ($('pdRetryRead')) $('pdRetryRead').onclick = async () => {
      const btn = $('pdRetryRead'); btn.disabled = true; btn.textContent = 'Loading…';
      const fresh = await fetchProductById(p.id);
      if (fresh) { showProduct(fresh, 'search', 'fresh'); return; }
      btn.disabled = false; btn.textContent = 'Retry';
    };
    if ($('pdEditForm')) wireProductEdit(p);
    if (p.id) wireStockCheck(p.id);
  }

  // §B1/§B2 — with hundreds of hits, leaving the list under the detail makes the page unusable.
  // Opening a hit hides the whole search pane, so the detail is the only thing on screen.
  /** Den Artikel FRISCH vom Server holen. `null`, wenn das aus irgendeinem Grund nicht gelingt. */
  async function fetchProductById(id) {
    if (!id) return null;
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch('/api/products/by-id/' + encodeURIComponent(id), { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) return null;
      const data = await res.json();
      return (data && data.id) ? data : null;
    } catch (_) { return null; }
  }

  // v0.8.48 — ein zwischengespeicherter Suchtreffer ist NICHT der bearbeitbare Zustand.
  //
  // Die Trefferliste bleibt beim Zurueckgehen bewusst erhalten (keine zweite Abfrage, keine
  // Umsortierung, kein Flackern). Sie taugt aber nur zur Navigation: nach einer eigenen Aenderung
  // traegt sie veraltete Felder, eine veraltete Galerie und vor allem einen veralteten
  // `gallery_baseline`. Wird sie zur Bearbeitungsgrundlage, speichert der Benutzer gegen eine Sicht,
  // die es nicht mehr gibt — und der Baseline-Schutz weist seinen eigenen zweiten Save als Konflikt
  // ab. Deshalb wird beim Oeffnen IMMER frisch gelesen; die Id aus dem Treffer ist alles, was von
  // ihm uebernommen wird.
  // v0.8.49 — das Zurueckwischen auf dem Handy ist KEIN neuer Seitenaufruf: der Browser holt
  // die Seite aus seinem Vor-/Zurueck-Speicher zurueck, genau so, wie sie war — samt eines
  // Bildschirms, der inzwischen veraltet sein kann. Das ist etwas anderes als der HTTP-Cache
  // und wird von `no-store` allein nicht zuverlaessig verhindert. Deshalb wird bei einer
  // Wiederherstellung ausdruecklich neu gelesen.
  window.addEventListener('pageshow', function (ev) {
    if (!ev.persisted) return;
    if (!currentProduct || !currentProduct.id) return;
    fetchProductById(currentProduct.id).then(function (fresh) {
      if (fresh) showProduct(fresh, currentOrigin, 'fresh');
    });
  });

  async function openHit(h) {
    const input = $('searchInput');
    searchReturn = { query: input ? input.value : '', hits: lastHits, scrollY: window.scrollY || 0 };
    hide('searchPane');
    const fresh = await fetchProductById(h && h.id);
    showProduct(fresh || h, 'search', fresh ? 'fresh' : 'stale');
  }

  // §B3 — back restores the query, the SAME results (no second round trip, so no reordering and no
  // flash of "searching") and the scroll offset the operator left at.
  function backToSearch() {
    if (!searchReturn) return;
    const state = searchReturn;
    searchReturn = null;
    releaseMedia();
    hide('scanResult');
    show('searchPane');
    const input = $('searchInput');
    if (input) input.value = state.query;
    renderHits(state.hits);
    // Restore in the SAME task, not on an animation frame. `renderHits` puts the rows in the DOM
    // synchronously, and reading `scrollHeight` forces the pending style/layout to be computed
    // right here — so by the next statement the document already has its full height and the
    // offset is reachable. The previous version waited for one frame, which a browser that treats
    // the window as occluded may delay or coalesce; the restore then silently never happened and
    // the operator landed back at the top of a list they had scrolled far down.
    void document.documentElement.scrollHeight;
    window.scrollTo(0, state.scrollY);
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }
  function statusLabel(s) { return s === 'available' ? 'Available' : (s === 'not_available' ? 'Not available' : String(s || '')); }
  function statusColour(s) { return s === 'available' ? '#7FA87F' : '#AA6E6E'; }

  function renderChecks(checks) {
    const latest = $('scLatest');
    if (!checks || !checks.length) {
      if (latest) latest.textContent = 'Never checked.';
      $('scHistory').innerHTML = '';
      return;
    }
    const c = checks[0];
    if (latest) {
      latest.innerHTML = '<span style="color:' + statusColour(c.status) + '; font-weight:600;">' + esc(statusLabel(c.status)) + '</span>'
        + ' &middot; ' + esc(fmtWhen(c.checked_at))
        + (c.checked_by_name ? ' &middot; ' + esc(c.checked_by_name) : '')
        + (c.notes ? '<div style="color:#EAEAEA; margin-top:4px;">' + esc(c.notes) + '</div>' : '');
    }
    // §20/§22 — earlier checks stay visible; a later verdict never erases the one before it.
    const older = checks.slice(1);
    $('scHistory').innerHTML = older.length
      ? '<div style="font-size:11px; color:#6B6B73; letter-spacing:.06em; text-transform:uppercase; margin-bottom:6px;">Earlier checks</div>'
        + older.map(function (o) {
            // §D3 — one line per fact instead of a `&middot;`-joined sentence. On a phone the old
            // form wrapped into an unreadable block as soon as a note was longer than a word.
            return '<div style="font-size:12px; padding:6px 0; border-top:1px solid #1A1A1F;">'
              + '<div style="display:flex; justify-content:space-between; gap:8px;">'
              +   '<span style="color:' + statusColour(o.status) + '; font-weight:600;">' + esc(statusLabel(o.status)) + '</span>'
              +   '<span style="color:#6B6B73; white-space:nowrap;">' + esc(fmtWhen(o.checked_at)) + '</span>'
              + '</div>'
              + (o.notes ? '<div style="color:#EAEAEA; margin-top:2px;">' + esc(o.notes) + '</div>' : '')
              + '<div style="color:#6B6B73; margin-top:2px;">' + esc(o.source || '') + (o.checked_by_name ? ' &middot; ' + esc(o.checked_by_name) : '') + '</div>'
              + '</div>';
          }).join('')
      : '';
  }

  async function loadChecks(productId) {
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      // `no-store`: eine Zaehl-Historie aus dem Cache verschweigt die letzte Zaehlung.
      const res = await fetch('/api/stock-checks?product_id=' + encodeURIComponent(productId) + '&limit=20',
        { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { const l = $('scLatest'); if (l) l.textContent = 'Check history unavailable.'; return; }
      const data = await res.json();
      renderChecks(data.checks || []);
    } catch (_) {
      const l = $('scLatest');
      if (l) l.textContent = 'Check history unavailable.';
    }
  }

  // ── MOBILE-EDIT-S2 — Textedit eines bestehenden Artikels ────────────────────
  //
  // Der Save laeuft ueber denselben `/api/sync/push`, den die Repair- und Purchase-Formulare seit
  // jeher benutzen — ein vollstaendig konsumierter Weg, kein neuer Job, kein Inbox-Eintrag, nichts
  // was liegenbleiben koennte. Entscheidend fuer die Sicherheit ist die Nutzlast: der Desktop
  // schreibt beim Anwenden GENAU die mitgeschickten Spalten. Was der Benutzer nicht geaendert hat,
  // steht nicht drin und bleibt darum unberuehrt — `media_links`, `images`, SKU und Preise fasst
  // dieser Weg nie an.
  const EDIT_FIELDS = [
    ['peName', 'name'],
    ['peBrand', 'brand'],
    ['peCondition', 'condition'],
    ['peLocation', 'storage_location'],
    ['peNotes', 'notes'],
  ];
  /**
   * v0.8.49 — nach "Saved." darf nicht der Bildschirm von vorhin stehenbleiben.
   *
   * Der Auftrag ist durabel: er liegt in der Warteschlange, der Desktop wendet ihn an, das
   * dauert einen Moment. Ein sofortiger Leseversuch wuerde deshalb den ALTEN Stand liefern und
   * wie ein verlorener Save aussehen. Also wird so lange frisch gelesen, bis der Server einen
   * NEUEREN Stand meldet (`updated_at`) — und dann wird genau dieser gezeichnet. Nichts wird
   * lokal zusammengebaut: sichtbar ist, was gespeichert wurde.
   *
   * Kommt in der Frist nichts an, bleibt das Formular stehen und sagt das auch. Lieber ein
   * ehrliches "noch nicht angewandt" als eine Anzeige, die etwas behauptet.
   */
  async function showSavedState(productId, seenUpdatedAt, msg) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      const fresh = await fetchProductById(productId);
      if (fresh && String(fresh.updated_at || '') !== String(seenUpdatedAt || '')) {
        showProduct(fresh, currentOrigin, 'fresh');
        const host = $('scanDetails');
        if (host) host.insertAdjacentHTML('afterbegin', '<div style="color:#7FA87F; font-size:13px; margin-bottom:10px;">Saved.</div>');
        return true;
      }
    }
    if (msg) { msg.style.color = '#C8A96A'; msg.textContent = 'Saved — the desktop has not applied it yet.'; }
    return false;
  }

  function wireProductEdit(p) {
    const btn = $('pdEditBtn'), form = $('pdEditForm'), msg = $('peMsg');
    if (!btn || !form) return;
    // Die Ausgangswerte, gegen die spaeter verglichen wird. Genau das, was der Read-Vertrag geliefert
    // hat — nicht das, was das Formular gerade zufaellig anzeigt.
    const original = { name: p.name, brand: p.brand, condition: p.condition, storage_location: p.storage_location, notes: p.notes };

    // ── v0.8.48 — die uebrigen fachlich erlaubten Felder ────────────────────
    //
    // Kategorieattribute, Lieferumfang und die drei Preise kommen aus derselben Definition, aus der
    // auch das Anlegeformular gebaut wird — es gibt keine zweite Liste fuers Bearbeiten. Die
    // Element-Ids tragen den Prefix `pea_`/`perow_`, damit sie sich nicht mit dem Anlegeformular
    // ueberlagern, das gleichzeitig im DOM steht.
    const cat = catById(p.category_id);
    const origAttrs = (function () { try { return typeof p.attributes === 'string' ? JSON.parse(p.attributes || '{}') : (p.attributes || {}); } catch (_) { return {}; } })();
    const origScope = (function () { try { return typeof p.scope_of_delivery === 'string' ? JSON.parse(p.scope_of_delivery || '[]') : (p.scope_of_delivery || []); } catch (_) { return []; } })();
    const priceEditable = p.price_editable === true;
    // Der Hinweis unter der Sperre. Benannt wird ein Grund NUR, wenn der Lesevertrag ihn sicher
    // kennt — `unknown` bleibt bewusst allgemein, statt einen plausiblen Grund zu erfinden.
    const priceLockText = (function () {
      const d = typeof p.price_lock_detail === 'string' ? p.price_lock_detail : '';
      if (p.price_lock_reason === 'linked' && d) return '\uD83D\uDD12 Price editing locked \u2014 linked to ' + d + '.';
      if (p.price_lock_reason === 'not_own_stock' && d === 'Consignment') return '\uD83D\uDD12 Price editing locked \u2014 consignment stock, the price belongs to the consignor.';
      if (p.price_lock_reason === 'not_own_stock' && d === 'Agent') return '\uD83D\uDD12 Price editing locked \u2014 this piece is out with an agent.';
      return '\uD83D\uDD12 Price editing locked for this item.';
    })();
    const PRICE_FIELDS = [['pePurchasePrice', 'purchase_price', 'purchasePrice'], ['peSalePrice', 'planned_sale_price', 'plannedSalePrice'], ['peMinSalePrice', 'min_sale_price', 'minSalePrice']];
    const peScopeState = new Set();

    function buildEditFields() {
      const cs = $('peCondition');
      if (cs) {
        cs.innerHTML = ''; cs.appendChild(el('option', { value: '' }, '— Select —'));
        for (const o of (cat ? cat.conditionOptions : [])) cs.appendChild(el('option', { value: o }, o));
        // Ein Altwert, den die Kategorie nicht mehr kennt, wird angeboten statt still verworfen —
        // sonst wuerde das blosse Oeffnen des Formulars ihn zur Aenderung machen.
        if (p.condition && (!cat || cat.conditionOptions.indexOf(p.condition) === -1)) cs.appendChild(el('option', { value: p.condition }, p.condition));
      }
      const host = $('peAttrs'); if (host) { host.innerHTML = '';
        if (cat) for (const a2 of cat.attributes) {
          const row = el('div', { class: 'row', id: 'perow_' + a2.key });
          const lbl = el('label'); lbl.innerHTML = a2.label + (a2.unit ? ' (' + a2.unit + ')' : '');
          row.appendChild(lbl); row.appendChild(makeControl(a2, 'pea_')); host.appendChild(row);
        }
        if (cat) for (const a2 of cat.attributes) {
          if (a2.dependsOn) { const dep = $('pea_' + a2.dependsOn.key); if (dep && dep.tagName === 'SELECT') dep.addEventListener('change', () => applyDependencies(cat, 'pea_')); }
        }
      }
      const scopeRow = $('peScopeRow'), scopeHost = $('peScope');
      if (scopeRow && scopeHost) {
        scopeHost.innerHTML = '';
        if (cat && cat.scopeOptions.length) {
          scopeRow.classList.remove('hidden');
          for (const o of cat.scopeOptions) {
            const b = el('button', { type: 'button', class: 'chip' }, o);
            b.onclick = () => { if (peScopeState.has(o)) { peScopeState.delete(o); b.classList.remove('on'); } else { peScopeState.add(o); b.classList.add('on'); } };
            scopeHost.appendChild(b);
          }
        } else { scopeRow.classList.add('hidden'); }
      }
      // Sichtbar in beiden Faellen — gesperrt heisst `disabled` plus Begruendung, nicht `hidden`.
      // Die uebrigen erlaubten Felder bleiben davon voellig unberuehrt.
      const lockNote = $('pePriceLock');
      if (lockNote) {
        lockNote.textContent = priceEditable ? '' : priceLockText;
        lockNote.classList.toggle('hidden', priceEditable);
      }
      for (const pf of PRICE_FIELDS) {
        const e = $(pf[0]); if (!e) continue;
        e.disabled = !priceEditable;
        e.style.opacity = priceEditable ? '' : '.55';
      }
    }

    /** Alle Felder auf den Ausgangsstand zuruecksetzen — Text, Attribute, Lieferumfang, Preise. */
    const fill = () => {
      for (const [id, key] of EDIT_FIELDS) { const e = $(id); if (e) e.value = original[key] == null ? '' : String(original[key]); }
      if (cat) for (const a2 of cat.attributes) {
        const e = $('pea_' + a2.key); if (!e) continue;
        const v = origAttrs[a2.key];
        if (a2.type === 'multiselect') { for (const c of e.children) c.classList.toggle('on', Array.isArray(v) && v.indexOf(c.textContent) !== -1); }
        else if (a2.type === 'boolean') { for (const c of e.children) c.classList.toggle('on', v !== undefined && String(v) === c.dataset.val); }
        else e.value = (v === undefined || v === null) ? '' : String(v);
      }
      peScopeState.clear();
      const scopeHost = $('peScope');
      if (scopeHost) for (const c of scopeHost.children) {
        const on = Array.isArray(origScope) && origScope.indexOf(c.textContent) !== -1;
        c.classList.toggle('on', on); if (on) peScopeState.add(c.textContent);
      }
      for (const [id, col] of PRICE_FIELDS) { const e = $(id); if (e) e.value = (p[col] === null || p[col] === undefined) ? '' : String(p[col]); }
      if (cat) applyDependencies(cat, 'pea_');
    };
    buildEditFields();
    fill();
    // Immer OEFFNEN, nie umschalten: nach einem Speichern bleibt das Formular mit seiner Meldung
    // stehen, und ein zweiter Tipp auf "Edit item" soll dann nicht ueberraschend zuklappen.
    // Geschlossen wird ueber Cancel.
    // ── MOBILE-EDIT-S3 — der Galerie-Teil des Formulars ────────────────────
    //
    // `peItems` IST der gewuenschte Endzustand: die Reihenfolge der nicht entfernten Eintraege ist
    // die Reihenfolge der Galerie, der erste ist das Titelbild. Ein bestehendes Bild wird nur durch
    // ein ausdrueckliches ✕ zum Entfernen markiert und bleibt bis zum Speichern sichtbar — es kann
    // nicht dadurch verschwinden, dass es hier fehlt.
    //
    // §1 fail closed: konnte die Galerie nicht gelesen werden (`gallery_ok === false`), gibt es
    // hier gar keinen Editor. Ohne verlaesslich gelesenen Stand darf nichts an ihr geaendert werden.
    const galleryOk = p.gallery_ok === true && Array.isArray(p.gallery) && typeof p.gallery_baseline === 'string';
    let peItems = [];
    let gallerySaved = false;   // nach einem erfolgreichen Galerie-Save ist der Baseline ueberholt
    const resetGallery = () => {
      peItems = galleryOk ? p.gallery.map(function (g) {
        return { kind: 'existing', linkId: g.link_id, mediaId: g.media_id, key: g.thumb_key || g.image_key, removed: false };
      }) : [];
      renderPeStrip();
    };
    const peKept = () => peItems.filter(function (it) { return !it.removed; });
    function renderPeStrip() {
      const strip = $('peStrip'), box = $('peGalleryBox'), err = $('peGalleryError');
      if (!strip || !box || !err) return;
      if (!galleryOk) {
        box.classList.add('hidden');
        err.classList.remove('hidden');
        err.textContent = 'The photos of this item could not be read. Editing photos is disabled — reload before changing anything.';
        return;
      }
      box.classList.remove('hidden');
      if (gallerySaved) {
        err.classList.remove('hidden');
        err.style.color = '#6B6B73';
        err.textContent = 'Photos saved. Reload the item to edit them again.';
      } else { err.classList.add('hidden'); err.style.color = '#AA6E6E'; }
      strip.innerHTML = '';
      const kept = peKept();
      peItems.forEach(function (it, i) {
        const isCover = !it.removed && kept.indexOf(it) === 0;
        // Die stabile Identitaet steht am Element: so ist im Test (und beim Nachsehen im Browser)
        // eindeutig, welches Bild gemeint ist — Position allein waere zweideutig.
        const t = el('div', { class: 'photo-thumb' + (isCover ? ' is-primary' : ''), 'data-link': it.kind === 'existing' ? it.linkId : '' });
        if (it.removed) t.style.opacity = '0.35';
        const im = el('img'); t.appendChild(im);
        // Ein bestehendes Bild kommt ueber die authentifizierte Medienroute (ein `<img src>` kann
        // keinen Authorization-Header tragen); ein noch nicht gespeichertes liegt bereits als
        // Data-URL vor.
        if (it.kind === 'new') { im.src = it.src; im.style.display = 'block'; } else paintMedia(im, it.key);
        if (isCover) t.appendChild(el('div', { class: 'cover' }, 'COVER'));
        if (it.removed) t.appendChild(el('div', { class: 'cover' }, 'REMOVED'));
        if (it.kind === 'new' && !it.removed) t.appendChild(el('div', { class: 'cover' }, 'NEW'));
        const rm = el('button', { type: 'button', class: 'rm' }, it.removed ? '↺' : '✕');
        rm.onclick = function (ev) {
          ev.stopPropagation(); ev.preventDefault();
          // Ein neues, noch nicht gespeichertes Bild wird einfach verworfen. Ein bestehendes wird
          // markiert — und laesst sich bis zum Speichern zurueckholen.
          if (it.kind === 'new') peItems.splice(i, 1); else it.removed = !it.removed;
          renderPeStrip();
        };
        t.appendChild(rm);
        if (!it.removed && kept.indexOf(it) > 0) {
          const left = el('button', { type: 'button', class: 'rm' }, '‹');
          left.style.right = 'auto'; left.style.left = '2px';
          left.onclick = function (ev) {
            ev.stopPropagation(); ev.preventDefault();
            const j = peItems.indexOf(it);
            let k = j - 1;
            while (k >= 0 && peItems[k].removed) k--;   // ueber markierte hinweg
            if (k >= 0) { peItems.splice(j, 1); peItems.splice(k, 0, it); renderPeStrip(); }
          };
          t.appendChild(left);
        }
        t.onclick = function () {
          if (it.removed) return;
          const j = peItems.indexOf(it);
          if (j <= 0) return;
          peItems.splice(j, 1); peItems.unshift(it);
          renderPeStrip();
        };
        strip.appendChild(t);
      });
      const hint = $('peAddHint');
      if (hint) hint.textContent = kept.length + ' of ' + MAX_PHOTOS + ' — ' + (MAX_PHOTOS - kept.length) + ' more possible';
    }
    if ($('peAddInput')) $('peAddInput').onchange = async function (e) {
      const files = Array.from((e.target && e.target.files) || []);
      if (!files.length) return;
      let rejected = 0;
      for (const f of files) {
        if (peKept().length >= MAX_PHOTOS) { rejected++; continue; }
        try {
          peItems.push({ kind: 'new', src: await resizePhoto(f, 1600, 0.85), removed: false });
        } catch (err) {
          // §15.A — ein unlesbares NEUES Bild darf die bestehende Auswahl nie mitreissen.
          if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'One photo could not be loaded — the others are kept.'; }
        }
      }
      e.target.value = '';
      renderPeStrip();
      if (rejected > 0 && msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'At most ' + MAX_PHOTOS + ' photos per item — ' + rejected + ' not added.'; }
    };
    resetGallery();

    btn.onclick = () => { fill(); resetGallery(); if (msg) msg.textContent = ''; form.classList.remove('hidden'); };
    // Cancel verwirft ALLES: Formular zu, Werte zurueck auf den Ausgangsstand, Galerie-Auswahl
    // zurueckgesetzt, kein einziger Request.
    $('peCancel').onclick = () => { fill(); resetGallery(); if (msg) msg.textContent = ''; form.classList.add('hidden'); };

    let saving = false;
    $('peSave').onclick = async () => {
      if (saving) return;                     // Doppeltipp: genau eine Mutation
      // Der Patch traegt AUSSCHLIESSLICH das, was der Benutzer wirklich geaendert hat — Feld fuer
      // Feld gegen den Ausgangsstand verglichen. Ein Feld, das er nicht angefasst hat, taucht gar
      // nicht auf und kann deshalb auch nicht mit leer ueberschrieben werden. Die Schluessel sind
      // die kanonischen Produktschluessel des Desktops, keine mobile Sondervokabel.
      const KEY_OF = { name: 'name', brand: 'brand', condition: 'condition', storage_location: 'storageLocation', notes: 'notes' };
      const KEY_OF_INV = { name: 'name', brand: 'brand', condition: 'condition', storageLocation: 'storage_location', notes: 'notes' };
      const changed = {};
      for (const [id, key] of EDIT_FIELDS) {
        const el = $(id); if (!el) continue;
        const now = el.value.trim();
        const before = original[key] == null ? '' : String(original[key]);
        if (now === before) continue;         // unveraendert → gar nicht erst mitschicken
        changed[KEY_OF[key]] = now === '' ? null : now;
      }

      // Kategorieattribute: nur die geaenderten Schluessel, und niemals ein ausgeblendetes Feld —
      // was `dependsOn` gerade verbirgt, gehoert nicht in den Patch.
      const attrPatch = {};
      if (cat) for (const a2 of cat.attributes) {
        if (!dependsSatisfied(a2, 'pea_')) continue;
        const v = readAttr(a2, 'pea_');
        if (v === undefined) continue;
        if (typeof v === 'number' && Number.isNaN(v)) return setText('peMsg', 'Please check the number in "' + a2.label + '".');
        const change = attrChange(v, origAttrs[a2.key]);
        if (change === undefined) continue;      // unveraendert → gar nicht erst mitschicken
        attrPatch[a2.key] = change;
      }
      if (Object.keys(attrPatch).length) changed.attributes = attrPatch;

      // Lieferumfang: als Ganzes, aber nur wenn er sich wirklich unterscheidet.
      if (cat && cat.scopeOptions.length) {
        const nowScope = cat.scopeOptions.filter(function (o) { return peScopeState.has(o); });
        const beforeScope = (Array.isArray(origScope) ? origScope : []).slice().sort();
        if (JSON.stringify(nowScope.slice().sort()) !== JSON.stringify(beforeScope)) changed.scopeOfDelivery = nowScope;
      }

      // Preise: nur wenn der Artikel sie ueberhaupt aendern darf, und nur die geaenderten.
      if (priceEditable) {
        for (const [id, col, key] of PRICE_FIELDS) {
          const e = $(id); if (!e) continue;
          const raw = (e.value || '').trim();
          const before = (p[col] === null || p[col] === undefined) ? '' : String(p[col]);
          if (raw === before) continue;
          if (raw === '') { changed[key] = null; continue; }   // leeren heisst "kein Preis", nicht 0
          const n = normNumber(raw);
          if (n === null || Number.isNaN(n)) return setText('peMsg', 'Please check the price fields.');
          changed[key] = n;
        }
      }
      // ── MOBILE-EDIT-S3 — den Galerie-Plan aus dem Streifen ableiten ──────
      //
      // `order` ist die gewuenschte Endreihenfolge, `remove` nennt jede zu entfernende bestehende
      // Verknuepfung AUSDRUECKLICH. Beides zusammen deckt die gesehene Galerie vollstaendig ab —
      // der Drain weist einen Plan zurueck, der das nicht tut.
      let galleryPlan = null;
      if (galleryOk && !gallerySaved) {
        const order = [], images = [], remove = [];
        for (const it of peKept()) {
          if (it.kind === 'existing') order.push({ keep: it.linkId });
          else { order.push({ new: images.length }); images.push(it.src); }
        }
        for (const it of peItems) if (it.kind === 'existing' && it.removed) remove.push(it.linkId);
        const before = p.gallery.map(function (g) { return g.link_id; }).join(',');
        const now = peKept().filter(function (it) { return it.kind === 'existing'; }).map(function (it) { return it.linkId; }).join(',');
        const galleryChanged = images.length > 0 || remove.length > 0 || before !== now;
        if (galleryChanged) galleryPlan = { order: order, images: images, remove: remove };
      }

      if (Object.keys(changed).length === 0 && !galleryPlan) {
        if (msg) { msg.style.color = '#6B6B73'; msg.textContent = 'Nothing changed.'; }
        return;
      }
      if (galleryPlan && galleryPlan.order.length > MAX_PHOTOS) {
        if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'At most ' + MAX_PHOTOS + ' photos per item.'; }
        return;
      }
      // Der Stand, gegen den verglichen wird: der, den dieser Bildschirm gelesen hat.
      const seenUpdatedAt = p.updated_at || '';
      saving = true;
      $('peSave').disabled = true;
      if (msg) { msg.style.color = '#6B6B73'; msg.textContent = 'Saving…'; }
      try {
        if (galleryPlan) {
          // Eigener durabler Job mit eigenem Vertrag. Der mitgeschickte `galleryBaseline` ist genau
          // der, den dieser Bildschirm beim Laden bekommen hat — hat sich die Galerie inzwischen
          // geaendert, wird der Job als Konflikt abgewiesen und NICHTS angewandt.
          const gEntry = await uploadQueue.enqueue({
            metadata: {
              kind: 'gallery_edit', productId: p.id, galleryBaseline: p.gallery_baseline,
              order: galleryPlan.order, remove: galleryPlan.remove,
              // §17 — Feldaenderungen reisen im SELBEN Job mit und werden in derselben Transaktion
              // angewandt. Sonst koennte "Preis gespeichert, Bild verloren" entstehen.
              ...(Object.keys(changed).length ? { patch: changed } : {}),
            },
            images: galleryPlan.images,
            protocolVersion: 2,
          });
          const gr = await uploadQueue.drainEntry(gEntry.uploadEventId, localStorage.getItem(TOKEN_KEY));
          if (gr && gr.outcome && gr.outcome !== 'done') throw new Error('Photos ' + gr.outcome);
          // Der Baseline dieses Bildschirms beschreibt jetzt einen ueberholten Stand. Statt den
          // naechsten Save garantiert in einen Konflikt laufen zu lassen, wird die Galerie hier
          // gesperrt, bis der Artikel neu geladen ist.
          gallerySaved = true;
          renderPeStrip();
        }
      } catch (e) {
        const raw = (e && e.message) ? String(e.message) : '';
        // §18 — ein Baseline-Konflikt ist kein Hintergrundfehler: der Artikel hat sich geaendert,
        // und der Benutzer muss neu laden, bevor er erneut speichert.
        const stale = /BASELINE_CHANGED|PLAN_INCOMPLETE|conflict/i.test(raw);
        if (msg) {
          msg.style.color = '#AA6E6E';
          msg.textContent = stale ? 'Item changed. Reload before saving.' : 'Save failed — nothing was changed. ' + raw;
        }
        saving = false;
        $('peSave').disabled = false;
        return;
      }
      try {
        // §17 — hat der Galerie-Job die Feldaenderungen schon mitgenommen, gibt es hier nichts mehr
        // zu tun. Ein zweiter Job wuerde denselben Patch ein zweites Mal anwenden wollen.
        if (galleryPlan || Object.keys(changed).length === 0) {
          if (msg) { msg.style.color = '#7FA87F'; msg.textContent = 'Saved.'; }
          for (const k of Object.keys(changed)) { if (KEY_OF_INV[k]) { original[KEY_OF_INV[k]] = changed[k]; p[KEY_OF_INV[k]] = changed[k]; } }
          saving = false; $('peSave').disabled = false;
          showSavedState(p.id, seenUpdatedAt, msg);
          return;
        }
        // Derselbe durable Weg wie ein neuer Artikel: Queue → /api/mobile/upload → Inbox → Drain.
        // Nur ohne Bilder und mit `mode:'edit'`. Der Drain wendet den Patch ueber den kanonischen
        // durablen Textedit an, der `media_links` nicht anfasst — es gibt keinen zweiten Schreibweg
        // und keinen Job, den niemand konsumiert.
        const entry = await uploadQueue.enqueue({
          metadata: { kind: 'text_edit', productId: p.id, patch: changed },
          images: [],
          protocolVersion: 2,
        });
        const r = await uploadQueue.drainEntry(entry.uploadEventId, localStorage.getItem(TOKEN_KEY));
        if (r && r.outcome && r.outcome !== 'done') throw new Error('Upload ' + r.outcome);
        for (const k of Object.keys(changed)) { if (KEY_OF_INV[k]) { original[KEY_OF_INV[k]] = changed[k]; p[KEY_OF_INV[k]] = changed[k]; } }
        if (msg) { msg.style.color = '#7FA87F'; msg.textContent = 'Saved.'; }
        showSavedState(p.id, seenUpdatedAt, msg);
      } catch (e) {
        // Fehlschlag aendert NICHTS — weder am Artikel noch am Formular. Der Benutzer kann es
        // erneut versuchen, ohne dass irgendwo ein halber Zustand zurueckbleibt.
        if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'Save failed — nothing was changed. ' + ((e && e.message) ? e.message : ''); }
      } finally {
        saving = false;
        $('peSave').disabled = false;
      }
    };
  }

  function wireStockCheck(productId) {
    loadChecks(productId);
    let busy = false;
    const save = async (status) => {
      if (busy) return;
      busy = true;
      const msg = $('scMsg');
      if (msg) { msg.style.color = '#6B6B73'; msg.textContent = 'Saving…'; }
      try {
        const token = localStorage.getItem(TOKEN_KEY);
        // §35 — one request identity per tap. A retry of THIS request is the same observation;
        // a deliberate second check is a new tap and therefore a new id.
        const res = await fetch('/api/stock-checks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({
            product_id: productId,
            status: status,
            notes: ($('scNotes') && $('scNotes').value) || null,
            request_id: uuid(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = data.error ? String(data.error) : ('Could not save (' + res.status + ').'); }
        } else {
          if (msg) { msg.style.color = '#7FA87F'; msg.textContent = 'Saved.'; }
          if ($('scNotes')) $('scNotes').value = '';
          await loadChecks(productId);
        }
      } catch (e) {
        if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'Could not save — no connection.'; }
      } finally { busy = false; }
    };
    if ($('scAvail')) $('scAvail').onclick = () => save('available');
    if ($('scMissing')) $('scMissing').onclick = () => save('not_available');
  }

  // ── MOBILE-I1 §11-§15 — Check Item search ──────────────────────────────────
  let searchSeq = 0;
  function renderHits(hits) {
    lastHits = hits || [];
    const box = $('searchResults');
    if (!hits.length) {
      box.innerHTML = '<div class="card" style="color:#6B6B73; text-align:center;">No matching item.</div>';
      return;
    }
    box.innerHTML = hits.map(function (h, i) {
      let attrs = {};
      try { attrs = typeof h.attributes === 'string' ? JSON.parse(h.attributes) : (h.attributes || {}); } catch (_) {}
      const ident = [h.sku, attrs.reference_number, attrs.serial_number].filter(Boolean).map(esc).join(' &middot; ');
      return '<div class="card hit" data-hit="' + i + '" style="display:flex; gap:12px; align-items:center; cursor:pointer; padding:10px;">'
        + '<img id="hitImg' + i + '" alt="" style="width:52px; height:52px; border-radius:6px; object-fit:cover; background:#1A1A1F; display:none; flex:0 0 auto;" />'
        + '<div style="min-width:0;">'
        +   (h.brand ? '<div style="font-size:11px; color:#6B6B73; text-transform:uppercase; letter-spacing:.06em;">' + esc(h.brand) + '</div>' : '')
        +   '<div style="color:#EAEAEA; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + esc(h.name || '—') + '</div>'
        +   (ident ? '<div style="font-size:12px; color:#6B6B73; font-family:monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + ident + '</div>' : '')
        + '</div></div>';
    }).join('');
    hits.forEach(function (h, i) {
      const card = box.querySelector('[data-hit="' + i + '"]');
      // §15 — picking a hit opens the SAME full product view the scanner opens.
      if (card) card.onclick = () => openHit(h);
      if (h.thumb_key || h.image_key) paintMedia(document.getElementById('hitImg' + i), h.thumb_key || h.image_key);
    });
  }

  async function runSearch(term) {
    const seq = ++searchSeq;
    const box = $('searchResults');
    if (term.trim().length < 2) { box.innerHTML = ''; return; }
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch('/api/products/search?q=' + encodeURIComponent(term) + '&limit=20',
        { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
      // A slower earlier request must never overwrite a newer answer.
      if (seq !== searchSeq) return;
      if (!res.ok) { box.innerHTML = '<div class="card" style="color:#AA6E6E;">Search failed (' + res.status + ').</div>'; return; }
      const data = await res.json();
      renderHits(data.results || []);
    } catch (e) {
      if (seq === searchSeq) box.innerHTML = '<div class="card" style="color:#AA6E6E;">Search unavailable.</div>';
    }
  }
  function stopScan() {
    scanRunning = false;
    scanBusy = false;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  }
  const scanAgainBtn = $('scanAgainBtn');
  if (scanAgainBtn) scanAgainBtn.onclick = () => { hide('scanResult'); releaseMedia(); stopScan(); startScan(); };

  // MOBILE-I1 — tab wiring plus a debounced search. The debounce is what keeps a per-keystroke
  // LIKE scan from running on every character while somebody types a serial number.
  if ($('tabScan')) $('tabScan').onclick = () => findMode('scan');
  if ($('tabSearch')) $('tabSearch').onclick = () => findMode('search');
  if ($('searchInput')) {
    let debounce = null;
    $('searchInput').addEventListener('input', (e) => {
      const term = e.target.value;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(term), 250);
    });
    $('searchInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (debounce) clearTimeout(debounce); runSearch(e.target.value); }
    });
  }

  // ── Perceptual Hash (pHash) — selbe Logik wie desktop/src/core/utils/image-hash.ts.
  // Wird beim Collection-Save mitgeschickt, damit der Desktop-SyncDuplicateGuard
  // den Score ohne Bild-Recompute vergleichen kann.
  function dct1d(input, N) {
    const out = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      let sum = 0;
      for (let n = 0; n < N; n++) sum += input[n] * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
      out[k] = sum;
    }
    return out;
  }
  function dct2d(input, N) {
    const rowDct = new Float64Array(N * N);
    const row = new Float64Array(N);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) row[c] = input[r * N + c];
      const d = dct1d(row, N);
      for (let c = 0; c < N; c++) rowDct[r * N + c] = d[c];
    }
    const out = new Float64Array(N * N);
    const col = new Float64Array(N);
    for (let c = 0; c < N; c++) {
      for (let r = 0; r < N; r++) col[r] = rowDct[r * N + c];
      const d = dct1d(col, N);
      for (let r = 0; r < N; r++) out[r * N + c] = d[r];
    }
    return out;
  }
  async function computePhash(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const N = 32;
          const canvas = document.createElement('canvas');
          canvas.width = N; canvas.height = N;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, N, N);
          const data = ctx.getImageData(0, 0, N, N).data;
          const lum = new Float64Array(N * N);
          for (let i = 0; i < N * N; i++) {
            lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
          }
          const dct = dct2d(lum, N);
          const sig = new Float64Array(64);
          let idx = 0;
          for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) sig[idx++] = dct[r * N + c];
          const sorted = [...sig.slice(1)].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)];
          let hash = 0n;
          for (let i = 0; i < 64; i++) if (sig[i] > median) hash |= (1n << BigInt(i));
          resolve(hash.toString(16).padStart(16, '0'));
        } catch (e) { reject(e); }
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // Foto auf max 1600px verkleinern + auf 0.85 JPEG komprimieren.
  function resizePhoto(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
            else { width = Math.round(width * maxDim / height); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // Generischer Foto-Input-Handler. resetEl = das innere HTML der leeren Area.
  function bindPhoto(mode, areaId, inputId, statusId, errId, emptyHtml) {
    $(inputId).onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        photos[mode] = await resizePhoto(file, 1600, 0.85);
        const area = $(areaId);
        area.innerHTML = '';
        area.classList.add('has-image');
        const img = document.createElement('img');
        img.src = photos[mode];
        area.appendChild(img);
        if (statusId) $(statusId).classList.remove('hidden');
      } catch (err) {
        setText(errId, 'Photo could not be loaded');
      } finally {
        // MOBILE-I1H — capture, selection and replacement all end here, so this is the one place a
        // new photo becomes visible to the rest of the form. In `finally` on purpose: a failed
        // decode must leave the button agreeing with whatever `photos` actually holds.
        syncAiButtonState();
      }
    };
  }
  const EMPTY_C = '<div class="icon">📷</div><div>Tap to take photos</div><div class="hint">or choose from gallery — several at once</div>';
  const EMPTY_R = '<div class="icon">📷</div><div>Tap to take photo</div><div class="hint">photograph the item at intake</div>';
  const EMPTY_B = '<div class="icon">📷</div><div>Tap to take photo</div><div class="hint">snap the item you bought</div>';

  // ── MOBILE-MULTI-IMAGE §3 — the collection form keeps an ORDERED LIST of photos ─────────────
  //
  // `collectionPhotos[0]` is the cover, exactly as the upload contract defines it (primary = slot 0),
  // so the strip the operator sees IS what gets uploaded — there is no second ordering rule hidden
  // anywhere. The server caps a batch at MAX_UPLOAD_IMAGES; the same cap is enforced here so the
  // operator learns about it while picking, not after a rejected upload.
  const MAX_PHOTOS = 8;
  const collectionPhotos = [];

  function renderCollectionPhotos() {
    const strip = $('cPhotoStrip'), area = $('cPhotoArea'), hint = $('cPhotoHint');
    strip.innerHTML = '';
    const has = collectionPhotos.length > 0;
    strip.classList.toggle('hidden', !has);
    hint.classList.toggle('hidden', !has);
    $('cPhotoStatus').classList.toggle('hidden', !has);
    if (has) $('cPhotoStatus').textContent = collectionPhotos.length + (collectionPhotos.length === 1 ? ' photo' : ' photos');
    // Die Aufnahmeflaeche bleibt IMMER sichtbar — sonst gaebe es keinen Weg, ein zweites Foto
    // hinzuzufuegen, ohne das erste zu verlieren.
    area.classList.remove('has-image');
    area.innerHTML = has
      ? '<div class="icon">📷</div><div>Add more photos</div><div class="hint">' + collectionPhotos.length + ' of ' + MAX_PHOTOS + ' selected</div>'
      : EMPTY_C;
    collectionPhotos.forEach(function (src, i) {
      const t = el('div', { class: 'photo-thumb' + (i === 0 ? ' is-primary' : '') });
      const im = el('img'); im.src = src; t.appendChild(im);
      if (i === 0) t.appendChild(el('div', { class: 'cover' }, 'COVER'));
      const rm = el('button', { type: 'button', class: 'rm' }, '✕');
      rm.onclick = function (ev) { ev.stopPropagation(); ev.preventDefault(); removeCollectionPhoto(i); };
      t.appendChild(rm);
      // Tippen befoerdert dieses Foto zum Cover — die Reihenfolge der uebrigen bleibt erhalten.
      t.onclick = function () { if (i === 0) return; const [p] = collectionPhotos.splice(i, 1); collectionPhotos.unshift(p); renderCollectionPhotos(); };
      strip.appendChild(t);
    });
    syncAiButtonState();
  }
  function removeCollectionPhoto(i) {
    if (i < 0 || i >= collectionPhotos.length) return;
    collectionPhotos.splice(i, 1);
    renderCollectionPhotos();
  }
  function clearCollectionPhotos() {
    collectionPhotos.length = 0;
    $('cPhotoInput').value = '';
    renderCollectionPhotos();
  }
  $('cPhotoInput').onchange = async (e) => {
    const files = Array.from((e.target && e.target.files) || []);
    if (!files.length) return;
    let rejected = 0;
    for (const f of files) {
      if (collectionPhotos.length >= MAX_PHOTOS) { rejected++; continue; }
      try {
        collectionPhotos.push(await resizePhoto(f, 1600, 0.85));
      } catch (err) {
        // Ein unlesbares Foto darf die bereits ausgewaehlten NIE mitreissen.
        setText('cError', 'One photo could not be loaded — the others are kept.');
      }
    }
    // Denselben Input erneut mit derselben Datei zu benutzen loest sonst kein `change` aus.
    e.target.value = '';
    renderCollectionPhotos();
    if (rejected > 0) setText('cError', 'At most ' + MAX_PHOTOS + ' photos per item — ' + rejected + ' not added.');
  };
  renderCollectionPhotos();

  // ── MOBILE-I1C §4 — AI Identify on the capture form ────────────────────────
  //
  // A SUGGESTION, applied field by field onto the CURRENT form. The rules, in order of how much
  // they matter:
  //   • the photo is never touched — identification reads it, nothing writes it;
  //   • the quantity is never touched — how many pieces are on the counter is a human's count,
  //     and the model has no way to know it;
  //   • a field the operator already filled is never overwritten — only gaps are filled;
  //   • a field the model did not recognise leaves the existing value alone.
  // The server already stripped every price and system field (shared allow-list), so nothing here
  // has to remember to avoid them — but the merge below only ever touches named identity fields
  // anyway, which is the second line of the same defence.
  function aiApplyToForm(result) {
    let filled = 0;
    const setIfEmpty = (id, value) => {
      const el = $(id);
      if (!el || value == null || value === '') return;
      if (String(el.value || '').trim() !== '') return;   // an operator decision always wins
      el.value = value;
      filled++;
    };
    setIfEmpty('cBrand', result.brand);
    setIfEmpty('cName', result.name);

    // Condition is a select: adopt only when the value is actually one of the offered options.
    const cond = $('cCondition');
    if (cond && result.condition && !String(cond.value || '').trim()) {
      const match = Array.from(cond.options).find(o => o.value && o.value.toLowerCase() === String(result.condition).toLowerCase());
      if (match) { cond.value = match.value; filled++; }
    }

    // Category attributes, keyed exactly as renderCollectionFields created them.
    const attrs = result.attributes || {};
    for (const key of Object.keys(attrs)) {
      const el = $('attr_' + key);
      if (!el) continue;                        // not a field of the chosen category → dropped
      if (el.tagName === 'SELECT') {
        if (String(el.value || '').trim() !== '') continue;
        const opt = Array.from(el.options).find(o => o.value && o.value.toLowerCase() === String(attrs[key]).toLowerCase());
        if (opt) { el.value = opt.value; filled++; }
      } else if (el.tagName === 'INPUT') {
        if (String(el.value || '').trim() !== '') continue;
        el.value = attrs[key];
        filled++;
      }
    }
    return filled;
  }

  let aiBusy = false;

  // MOBILE-I1H — the AI button is DERIVED from the one canonical photo state, never polled.
  //
  // `collectionPhotos` is written in exactly three places - the capture handler, removeCollectionPhoto and
  // `clearCollectionPhotos` (which the post-upload reset runs through) - all of them re-render, and the
  // version re-read the same state on a 400 ms timer, which meant the button could lag a capture by
  // up to a frame budget's worth of scheduling and made the e2e wait for it flaky under load.
  //
  // UI state only: nothing here reads or writes AI, upload, media or quantity.
  function syncAiButtonState() {
    const btn = $('cAiBtn');
    if (!btn) return;
    if (collectionPhotos.length) btn.classList.remove('hidden'); else btn.classList.add('hidden');
  }
  syncAiButtonState();   // initial: no photo yet, so the button starts hidden

  if ($('cAiBtn')) $('cAiBtn').onclick = async () => {
    if (aiBusy) return;
    const msg = $('cAiMsg');
    if (!collectionPhotos.length) { if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'Take a photo first.'; } return; }
    aiBusy = true;
    $('cAiBtn').textContent = 'Identifying…';
    if (msg) { msg.style.color = '#6B6B73'; msg.textContent = 'Reading the photo…'; }
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch('/api/ai/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          category_id: $('cCategory').value,
          image: collectionPhotos[0],
          hints: [$('cBrand').value, $('cName').value].filter(Boolean).join(' ').trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        // §4 — a failure changes NOTHING. The photo, the quantity and every typed value stay put,
        // and the operator can simply fill the form in by hand and upload as before.
        if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = data.error ? String(data.error) : ('Identify failed (' + res.status + ').'); }
      } else {
        const filled = aiApplyToForm(data.result || {});
        if (msg) {
          msg.style.color = filled ? '#7FA87F' : '#6B6B73';
          msg.textContent = filled
            ? ('Filled ' + filled + ' empty field' + (filled === 1 ? '' : 's') + ' — please check before saving.')
            : 'Nothing new recognised — your entries are unchanged.';
        }
      }
    } catch (e) {
      if (msg) { msg.style.color = '#AA6E6E'; msg.textContent = 'Identify unavailable — you can still fill the form and upload.'; }
    } finally {
      aiBusy = false;
      $('cAiBtn').textContent = '✨  AI Identify';
    }
  };
  bindPhoto('repair', 'rPhotoArea', 'rPhotoInput', 'rPhotoStatus', 'rError', EMPTY_R);
  bindPhoto('purchase', 'bPhotoArea', 'bPhotoInput', 'bPhotoStatus', 'bError', EMPTY_B);

  function clearPhoto(mode, areaId, inputId, statusId, emptyHtml) {
    photos[mode] = null;
    $(inputId).value = '';
    const area = $(areaId);
    area.classList.remove('has-image');
    area.innerHTML = emptyHtml;
    if (statusId) $(statusId).classList.add('hidden');
    // MOBILE-I1H — removal and the post-upload form reset both run through here.
    syncAiButtonState();
  }

  // Gemeinsamer Sync-Push. Wirft bei 401 (Session) + Fehlern.
  async function pushChanges(changes) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { init(); throw new Error('Not signed in'); }
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ changes }),
    });
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      init();
      setText('loginError', 'Session expired. Please sign in again.');
      throw new Error('Session expired');
    }
    if (!res.ok) throw new Error('Save failed: ' + res.status);
    return res.json();
  }

  const ctx = () => ({
    now: new Date().toISOString(),
    branchId: localStorage.getItem(BRANCH_KEY) || 'branch-main',
    userId: localStorage.getItem(USER_KEY) || null,
  });

  // ── Collection — New Item (MOBILE-FIELDS: full desktop-parity fields from the SSOT schema; durable queue
  //    → POST /api/mobile/upload, same as MOBILE-04B2A9) ──
  const SCHEMA = (window.__MOBILE_FIELD_SCHEMA__ && Array.isArray(window.__MOBILE_FIELD_SCHEMA__.categories))
    ? window.__MOBILE_FIELD_SCHEMA__ : { version: 0, categories: [] };
  const catById = (id) => SCHEMA.categories.find((c) => c.id === id) || null;
  const scopeState = new Set(); // selected Included values for the CURRENT category (reset on switch)

  // Category picker options come from the schema (SSOT) — never a hardcoded list.
  (function initCategoryOptions() {
    const sel = $('cCategory'); sel.innerHTML = '';
    for (const c of SCHEMA.categories) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; sel.appendChild(o); }
  })();

  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    if (text != null) e.textContent = text; return e;
  }
  function dependsSatisfied(attr, pre) {
    if (!attr.dependsOn) return true;
    const dep = $((pre || 'attr_') + attr.dependsOn.key);
    return dep ? attr.dependsOn.valueIncludes.indexOf(dep.value) !== -1 : false;
  }
  // Prefix, damit dieselbe Aufbaulogik zweimal im DOM leben kann: das Anlegeformular unter `attr_`,
  // das Bearbeitungsformular unter `pea_`. Ohne den Prefix wuerden sich die Element-Ids ueberlagern
  // und `$()` das falsche Feld liefern.
  function applyDependencies(cat, pre) {
    const p = pre || 'attr_';
    for (const a of cat.attributes) { if (!a.dependsOn) continue; const row = $((p === 'attr_' ? 'row_' : 'perow_') + a.key); if (row) row.classList.toggle('hidden', !dependsSatisfied(a, p)); }
  }
  function makeControl(a, pre) {
    const idOf = (k) => (pre || 'attr_') + k;
    if (a.type === 'select') {
      const s = el('select', { id: idOf(a.key) }); s.appendChild(el('option', { value: '' }, '— Select —'));
      for (const o of (a.options || [])) s.appendChild(el('option', { value: o }, o)); return s;
    }
    if (a.type === 'multiselect' || a.type === 'boolean') {
      const wrap = el('div', { id: idOf(a.key), class: 'chips' }); wrap.dataset.kind = a.type;
      const opts = a.type === 'boolean' ? ['Yes', 'No'] : (a.options || []);
      for (const o of opts) {
        const b = el('button', { type: 'button', class: 'chip' }, o);
        if (a.type === 'boolean') b.dataset.val = (o === 'Yes') ? 'true' : 'false';
        b.onclick = () => { if (a.type === 'boolean') { for (const c of wrap.children) c.classList.remove('on'); b.classList.add('on'); } else { b.classList.toggle('on'); } };
        wrap.appendChild(b);
      }
      return wrap;
    }
    const inp = el('input', { id: idOf(a.key), type: a.type === 'number' ? 'number' : 'text' });
    if (a.type === 'number') { inp.setAttribute('inputmode', 'decimal'); inp.setAttribute('step', 'any'); inp.setAttribute('min', '0'); }
    return inp;
  }
  function renderCollectionFields(catId) {
    const cat = catById(catId); scopeState.clear();
    const brandReq = cat ? !!cat.brandRequired : false;
    $('cBrandLabel').innerHTML = 'Brand' + (brandReq ? ' <span class="req">*</span>' : '');
    $('cNameLabel').innerHTML = 'Model / Name' + (brandReq ? ' <span class="req">*</span>' : '');
    const cs = $('cCondition'); cs.innerHTML = ''; cs.appendChild(el('option', { value: '' }, '— Select —'));
    for (const o of (cat ? cat.conditionOptions : [])) cs.appendChild(el('option', { value: o }, o));
    const host = $('cAttrs'); host.innerHTML = '';
    if (cat) for (const a of cat.attributes) {
      const row = el('div', { class: 'row', id: 'row_' + a.key });
      const lbl = el('label'); lbl.innerHTML = a.label + (a.unit ? ' (' + a.unit + ')' : '') + (a.required ? ' <span class="req">*</span>' : '');
      row.appendChild(lbl); row.appendChild(makeControl(a)); host.appendChild(row);
    }
    if (cat) for (const a of cat.attributes) {
      if (a.dependsOn) { const dep = $('attr_' + a.dependsOn.key); if (dep && dep.tagName === 'SELECT') dep.addEventListener('change', () => applyDependencies(cat)); }
    }
    applyDependencies(cat || { attributes: [] });
    const scopeRow = $('cScopeRow'), scopeHost = $('cScope'); scopeHost.innerHTML = '';
    if (cat && cat.scopeOptions.length) {
      scopeRow.classList.remove('hidden');
      for (const o of cat.scopeOptions) { const b = el('button', { type: 'button', class: 'chip' }, o); b.onclick = () => { if (scopeState.has(o)) { scopeState.delete(o); b.classList.remove('on'); } else { scopeState.add(o); b.classList.add('on'); } }; scopeHost.appendChild(b); }
    } else { scopeRow.classList.add('hidden'); }
  }
  $('cCategory').addEventListener('change', () => { $('cCondition').value = ''; renderCollectionFields($('cCategory').value); });

  // Controlled decimal normalisation: accept "1.25" or "1,25"; reject anything else / negatives → NaN.
  function normNumber(raw) {
    const s = String(raw == null ? '' : raw).trim().replace(',', '.');
    if (s === '') return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return NaN;
    const n = Number(s); return Number.isFinite(n) ? n : NaN;
  }
  /**
   * v0.8.49 — was ein Attribut zum Patch beitraegt. Drei Faelle, und nur drei:
   *
   *   war leer, ist leer      → gar nichts (der Schluessel taucht im Patch NICHT auf)
   *   hatte einen Wert, jetzt leer → ausdrueckliches `null` (bewusstes Loeschen bleibt moeglich)
   *   Wert geaendert          → der neue Wert
   *
   * Vorher rutschte jedes leere ZAHLENfeld als `null` in jeden Patch: ein leeres Eingabefeld
   * liest sich als `null`, ein nie gesetztes Attribut als `undefined`, und der Textvergleich
   * ("null" gegen "") sagte "geaendert". In echten Payloads stand deshalb bei jedem Speichern
   * `year: null` — eine Aenderung, die niemand vorgenommen hatte.
   *
   * Rueckgabe `undefined` heisst ausdruecklich "keine Aenderung"; `null` heisst "geleert".
   */
  function attrChange(now, before) {
    const empty = (x) => x === undefined || x === null || x === '' || (Array.isArray(x) && x.length === 0);
    if (empty(now) && empty(before)) return undefined;
    if (empty(now)) return null;
    if (Array.isArray(now) || Array.isArray(before)) {
      const a = Array.isArray(now) ? now : [], b = Array.isArray(before) ? before : [];
      return (a.length === b.length && a.every((x, i) => x === b[i])) ? undefined : now;
    }
    return String(now) === String(before) ? undefined : now;
  }

  function readAttr(a, pre) {
    const e = $((pre || 'attr_') + a.key); if (!e) return undefined;
    if (a.type === 'multiselect') { const out = []; for (const c of e.children) if (c.classList.contains('on')) out.push(c.textContent); return out; }
    if (a.type === 'boolean') { for (const c of e.children) if (c.classList.contains('on')) return c.dataset.val === 'true'; return undefined; }
    if (a.type === 'number') return normNumber(e.value);
    return e.value.trim();
  }
  // MOBILE-PRICING — read one BHD price input. Normalises a decimal comma to a dot (locale keypads),
  // rejects anything non-numeric or negative (NaN), and maps an empty field to null (optional). No
  // silent float rounding — the value is passed through as-is. Mirrors the desktop optional-pricing
  // contract; the server (v2) validates independently.
  function readPrice(id) {
    const e = $(id); if (!e) return null;
    let s = (e.value || '').trim().replace(',', '.');
    if (s === '') return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return NaN;   // no sign, no exponent, no NaN/Infinity text
    const n = Number(s);
    return (Number.isFinite(n) && n >= 0) ? n : NaN;
  }
  // MOBILE-QUANTITY — read the piece count. Empty → null (the desktop default of 1 applies and the
  // key is simply omitted). Anything that is not a whole number ≥ 1 is NaN → a hard, named error;
  // nothing is rounded or clamped into shape here, because a silent correction of a count is how you
  // end up with the wrong stock.
  function readQuantity() {
    const e = $('cQuantity'); if (!e) return null;
    const s = (e.value || '').trim();
    if (s === '') return null;
    if (!/^[0-9]+$/.test(s)) return NaN;
    const n = Number(s);
    return (Number.isSafeInteger(n) && n >= 1) ? n : NaN;
  }
  function buildCollectionMetadata() {
    const categoryId = $('cCategory').value, cat = catById(categoryId);
    const brand = $('cBrand').value.trim(), name = $('cName').value.trim(), sku = $('cSku').value.trim();
    const condition = $('cCondition').value || '';
    const attributes = {}, errors = [];
    if (cat) {
      if (cat.brandRequired) { if (!brand) errors.push('Brand is required.'); if (!name) errors.push('Model / Name is required.'); }
      for (const a of cat.attributes) {
        if (!dependsSatisfied(a)) continue; // never send hidden fields, and never other categories' fields
        const v = readAttr(a);
        if (a.type === 'number' && Number.isNaN(v)) { errors.push(a.label + ' must be a valid number ≥ 0.'); continue; }
        const empty = v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0);
        if (empty) { if (a.required) errors.push(a.label + ' is required.'); continue; }
        attributes[a.key] = v;
      }
    }
    const scopeOfDelivery = Array.from(scopeState);
    const metadata = { categoryId, brand, name, sku: sku || null, attributes };
    if (condition) metadata.condition = condition;
    if (scopeOfDelivery.length) metadata.scopeOfDelivery = scopeOfDelivery;
    // MOBILE-PRICING — the three canonical prices (optional). A malformed entry is a hard error; an
    // empty one is simply omitted (→ desktop null/default). No relation rule (min≤sale) is enforced —
    // the desktop does not enforce one at product save, so neither do we.
    const prices = [['purchasePrice', 'cPurchasePrice', 'Purchase Price'], ['plannedSalePrice', 'cSalePrice', 'Sale Price'], ['minSalePrice', 'cMinSalePrice', 'Min Sale Price']];
    for (const [key, id, lbl] of prices) {
      const v = readPrice(id);
      if (Number.isNaN(v)) { errors.push(lbl + ' must be a valid number ≥ 0.'); continue; }
      if (v !== null) metadata[key] = v;
    }
    const qty = readQuantity();
    if (Number.isNaN(qty)) errors.push('Quantity must be a whole number of at least 1.');
    else if (qty !== null) metadata.quantity = qty;
    return { metadata, errors, label: (brand + ' ' + name).trim() || sku || 'Item' };
  }

  function clearCollectionForm() {
    $('cBrand').value = ''; $('cName').value = ''; $('cSku').value = '';
    $('cPurchasePrice').value = ''; $('cSalePrice').value = ''; $('cMinSalePrice').value = '';
    $('cQuantity').value = '1';   // back to the overwhelmingly common case, never to empty
    renderCollectionFields($('cCategory').value); // resets condition/attributes/scope for the current category
    clearCollectionPhotos();
  }
  $('cRetryPending').onclick = drainPending;
  $('cSaveBtn').onclick = async () => {
    setText('cError', ''); setText('cSuccess', '');
    if (!collectionPhotos.length) return setText('cError', 'A photo is required for a mobile upload.');
    const { metadata, errors, label } = buildCollectionMetadata();
    if (errors.length) return setText('cError', errors[0]);
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { init(); return setText('cError', 'Please sign in again.'); }
    // Disable synchronously so a rapid double-click cannot enqueue a second event for the same capture.
    $('cSaveBtn').disabled = true;
    try {
      // Full desktop-parity metadata (brand/name/sku/condition/Included/attributes + the three optional prices).
      // The durable entry (uploadEventId + bytes + FULL metadata) is persisted BEFORE the first request, so an
      // offline retry resends the exact same fields under the same id. Scope comes from the JWT server-side.
      const entry = await uploadQueue.enqueue({ metadata, images: collectionPhotos.slice(), protocolVersion: 2 });
      const r = await uploadQueue.drainEntry(entry.uploadEventId, token);
      if (r.outcome === 'done') {
        setText('cSuccess', label + ' uploaded. It appears on the desktop once the owner enables mobile uploads.');
        clearCollectionForm(); window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (r.outcome === 'conflict') {
        setText('cError', 'This exact upload was already received — no duplicate was created.'); clearCollectionForm();
      } else if (r.outcome === 'rejected') {
        setText('cError', 'Upload rejected (' + r.status + '). Check the fields or retake the photo, then try again.');
      } else if (r.outcome === 'reauth') {
        localStorage.removeItem(TOKEN_KEY); init(); setText('loginError', 'Session expired. Please sign in again.');
      } else {
        setText('cSuccess', label + ' queued — it will resume automatically. Use "Retry pending" to send now.'); clearCollectionForm();
      }
      await updatePending();
    } catch (e) {
      setText('cError', (e && e.message) || 'Save failed');
    }
    $('cSaveBtn').disabled = false;
  };
  // Initial render for the default (first) category.
  renderCollectionFields($('cCategory').value);

  // ── Repair — New Intake ──
  $('rSaveBtn').onclick = async () => {
    setText('rError', ''); setText('rSuccess', '');
    const custName = $('rCustomer').value.trim();
    const issue = $('rIssue').value.trim();
    if (!custName) return setText('rError', 'Customer name is required.');
    if (!issue) return setText('rError', 'Describe the issue / problem.');
    $('rSaveBtn').disabled = true;
    try {
      const { now, branchId, userId } = ctx();
      const customerId = uuid();
      const repairId = uuid();
      const parts = custName.split(/\s+/);
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      const customerData = {
        id: customerId, branch_id: branchId,
        first_name: firstName, last_name: lastName,
        created_at: now, updated_at: now,
      };
      const repairData = {
        id: repairId, branch_id: branchId,
        repair_number: 'REP-MOB-' + Date.now(),
        // v0.4.1 — Pickup-Voucher-Code generieren (8 Hex, wie repairStore.generateVoucherCode).
        // Ohne den hat das vom Handy angelegte Repair keinen Abhol-Code.
        voucher_code: uuid().replace(/-/g, '').substring(0, 8).toUpperCase(),
        customer_id: customerId,
        item_brand: $('rBrand').value.trim() || null,
        item_model: $('rModel').value.trim() || null,
        issue_description: issue,
        repair_type: 'internal',
        status: 'received',
        received_at: now,
        images: JSON.stringify(photos.repair ? [photos.repair] : []),
        notes: $('rNotes').value.trim() || null,
        created_at: now, updated_at: now, created_by: userId,
      };
      await pushChanges([
        { table_name: 'customers', record_id: customerId, action: 'insert', data: JSON.stringify(customerData) },
        { table_name: 'repairs', record_id: repairId, action: 'insert', data: JSON.stringify(repairData) },
      ]);
      setText('rSuccess', 'Repair intake for ' + custName + ' saved. Check the desktop within 30 seconds.');
      $('rCustomer').value = ''; $('rBrand').value = ''; $('rModel').value = '';
      $('rIssue').value = ''; $('rNotes').value = '';
      clearPhoto('repair', 'rPhotoArea', 'rPhotoInput', 'rPhotoStatus', EMPTY_R);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e.message !== 'Session expired') setText('rError', e.message || 'Save failed');
    }
    $('rSaveBtn').disabled = false;
  };

  // ── Purchase — Photo to Inbox ──
  $('bSaveBtn').onclick = async () => {
    setText('bError', ''); setText('bSuccess', '');
    if (!photos.purchase) return setText('bError', 'Take a photo of the item first.');
    $('bSaveBtn').disabled = true;
    try {
      const { now, branchId, userId } = ctx();
      const inboxId = uuid();
      const inboxData = {
        id: inboxId, branch_id: branchId,
        images: JSON.stringify([photos.purchase]),
        note: $('bNote').value.trim() || null,
        status: 'pending',
        created_at: now, created_by: userId,
      };
      await pushChanges([{ table_name: 'purchase_inbox', record_id: inboxId, action: 'insert', data: JSON.stringify(inboxData) }]);
      setText('bSuccess', 'Photo sent to the Purchase Inbox. Open it on the desktop to create the purchase.');
      $('bNote').value = '';
      clearPhoto('purchase', 'bPhotoArea', 'bPhotoInput', 'bPhotoStatus', EMPTY_B);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e.message !== 'Session expired') setText('bError', e.message || 'Save failed');
    }
    $('bSaveBtn').disabled = false;
  };

  init();
})();
</script>
</body>
</html>"##);

// v0.4.1 — Landing-Seite fuer "/" (NICHT die Mobile-Capture). Verhindert, dass
// am Counter beim Oeffnen der nackten Sync-URL die Mobile-Version erscheint.
// Die volle Software ist die installierte LATAIF-Desktop-App; dieser Server
// ist nur der LAN-Sync-Endpunkt. Die Mobile-Capture liegt ausschliesslich
// unter /mobile (mit Direkt-Link von hier fuers Handy).
pub const ROOT_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0B0B0D" />
<title>LATAIF Sync Server</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #08080A; color: #EAEAEA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .wrap { max-width: 420px; width: 100%; text-align: center; }
  h1 { font-size: 24px; letter-spacing: 0.25em; color: #C6A36D; font-weight: 300; }
  .sub { font-size: 11px; color: #6B6B73; letter-spacing: 0.12em; margin-top: 6px; text-transform: uppercase; }
  .card { background: #121216; border: 1px solid #1A1A1F; border-radius: 10px; padding: 24px; margin-top: 28px; }
  .lead { font-size: 14px; color: #A1A1AA; line-height: 1.6; }
  .btn { display: block; margin-top: 18px; background: #C6A36D; color: #0B0B0D; text-decoration: none;
    border-radius: 6px; padding: 14px; font-size: 15px; font-weight: 600; letter-spacing: 0.03em; }
  .note { font-size: 12px; color: #6B6B73; line-height: 1.6; margin-top: 18px;
    padding-top: 16px; border-top: 1px solid #1A1A1F; }
  .note strong { color: #A1A1AA; }
</style>
</head>
<body>
<div class="wrap">
  <h1>LATAIF</h1>
  <p class="sub">Local Sync Server</p>
  <div class="card">
    <p class="lead">This address is the local <strong style="color:#A1A1AA;">sync server</strong> — not the application.</p>
    <a class="btn" href="/mobile">📱 Open Mobile Capture</a>
    <p class="note">
      💻 At the counter, work in the installed <strong>LATAIF desktop app</strong> —
      that is the full software. This page is only for phones capturing photos.
    </p>
  </div>
</div>
</body>
</html>"##;
