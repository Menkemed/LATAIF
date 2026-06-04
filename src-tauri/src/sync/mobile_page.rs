// Self-contained mobile capture page served at /mobile.
// Pure HTML/JS/CSS, zero build step. Works on any mobile browser in LAN.
//
// v0.4.0 — Vorfilter: nach dem Login waehlt der User EINEN von drei Modi:
//   • Collection — New Item  → legt ein Produkt an (products-Insert).
//   • Repair — New Intake    → legt Customer + Repair an (received).
//   • Purchase — Photo        → legt nur ein Foto in die purchase_inbox.
//                               Die echte Purchase macht der Owner am Desktop.

pub const MOBILE_HTML: &str = r##"<!DOCTYPE html>
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
  .photo-area .icon { font-size: 36px; }
  .hidden { display: none; }
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
    <button class="mode-btn" data-mode="scan">🔍&nbsp; Scan a Tag<span>Live barcode scan — read a printed tag's SKU</span></button>
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
      <span style="font-size: 13px; color: #A1A1AA;">Photo</span>
      <span id="cPhotoStatus" class="badge hidden">Captured</span>
    </div>
    <label for="cPhotoInput" class="photo-area" id="cPhotoArea">
      <div class="icon">📷</div>
      <div>Tap to take photo</div>
      <div class="hint">or choose from gallery</div>
    </label>
    <input id="cPhotoInput" class="hidden" type="file" accept="image/*" capture="environment" />
  </div>

  <div class="card">
    <div class="row">
      <label>Category *</label>
      <select id="cCategory">
        <option value="cat-watch">Watch</option>
        <option value="cat-gold-jewelry">Gold Jewelry</option>
        <option value="cat-branded-gold-jewelry">Branded Gold Jewelry</option>
        <option value="cat-original-gold-jewelry">Original Gold Jewelry</option>
        <option value="cat-accessory">Accessory</option>
        <option value="cat-spare-part">Spare Part</option>
      </select>
    </div>
    <div class="row">
      <label>Brand</label>
      <input id="cBrand" type="text" placeholder="e.g. Rolex (optional)" />
    </div>
    <div class="row">
      <label>Model / Name</label>
      <input id="cName" type="text" placeholder="e.g. Submariner Date (optional)" />
    </div>
    <div class="row">
      <label>SKU / Reference</label>
      <input id="cSku" type="text" placeholder="optional" />
    </div>
    <div class="row">
      <label>Purchase Price (BHD)</label>
      <input id="cPurchasePrice" type="number" inputmode="decimal" step="0.01" placeholder="0.00" />
    </div>
    <div class="row">
      <label>Asking Price (BHD)</label>
      <input id="cSalePrice" type="number" inputmode="decimal" step="0.01" placeholder="0.00" />
    </div>
    <div class="row">
      <label>Notes</label>
      <textarea id="cNotes" rows="3" placeholder="Condition, supplier, etc."></textarea>
    </div>
  </div>

  <button id="cSaveBtn">Save Product</button>
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
    <p>Scan Tag</p>
  </div>
  <div id="scanMsg" class="error hidden"></div>
  <div class="card" style="padding: 0; overflow: hidden;">
    <video id="scanVideo" playsinline muted style="width:100%; display:block; background:#000; aspect-ratio:3/4; object-fit:cover;"></video>
  </div>
  <div id="scanResult" class="card hidden" style="text-align:center;">
    <label style="margin-bottom:6px;">Scanned</label>
    <div id="scanValue" style="font-size:24px; font-weight:600; color:#C6A36D; font-family:monospace; word-break:break-all;"></div>
    <button id="scanAgainBtn" class="ghost" style="margin-top:14px;">Scan again</button>
  </div>
  <p style="color:#6B6B73; font-size:12px; margin-top:8px; line-height:1.5;">
    Hold a printed tag in front of the rear camera. Camera access needs HTTPS or localhost.
  </p>
</div>

<script>
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

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function init() {
    if (localStorage.getItem(TOKEN_KEY)) screen('modePicker');
    else screen('login');
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
      else if (mode === 'scan') { screen('scanScreen'); startScan(); }
    };
  });
  document.querySelectorAll('[data-back]').forEach(btn => {
    btn.onclick = () => { stopScan(); screen('modePicker'); };
  });

  // ── Live Barcode Scanner (getUserMedia + BarcodeDetector) ──
  // Braucht "secure context" (HTTPS oder localhost) — sonst ist mediaDevices nicht da.
  let scanStream = null, scanRunning = false, scanDetector = null;
  async function startScan() {
    setText('scanMsg', '');
    hide('scanResult');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return setText('scanMsg', 'Camera needs HTTPS or localhost. To test now, open this page on the PC via http://localhost:3001/mobile. For phones we set up HTTPS.');
    }
    if (!('BarcodeDetector' in window)) {
      return setText('scanMsg', 'Live scan not supported on this browser (e.g. iOS/Safari). Test on Android Chrome — iOS gets a ZXing fallback later.');
    }
    try {
      scanDetector = new BarcodeDetector({ formats: ['code_128', 'ean_13', 'upc_a', 'qr_code'] });
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const v = $('scanVideo');
      v.srcObject = scanStream;
      await v.play();
      scanRunning = true;
      loopScan();
    } catch (e) {
      setText('scanMsg', 'Camera failed: ' + (e && e.message ? e.message : e));
    }
  }
  async function loopScan() {
    if (!scanRunning) return;
    try {
      const codes = await scanDetector.detect($('scanVideo'));
      if (codes && codes.length) { onScan(codes[0].rawValue); return; }
    } catch (_) { /* transient decode error — keep going */ }
    requestAnimationFrame(loopScan);
  }
  function onScan(value) {
    scanRunning = false;
    if (navigator.vibrate) navigator.vibrate(80);
    $('scanValue').textContent = value;
    show('scanResult');
  }
  function stopScan() {
    scanRunning = false;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  }
  const scanAgainBtn = $('scanAgainBtn');
  if (scanAgainBtn) scanAgainBtn.onclick = () => { hide('scanResult'); scanRunning = true; loopScan(); };

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
      }
    };
  }
  const EMPTY_C = '<div class="icon">📷</div><div>Tap to take photo</div><div class="hint">or choose from gallery</div>';
  const EMPTY_R = '<div class="icon">📷</div><div>Tap to take photo</div><div class="hint">photograph the item at intake</div>';
  const EMPTY_B = '<div class="icon">📷</div><div>Tap to take photo</div><div class="hint">snap the item you bought</div>';
  bindPhoto('collection', 'cPhotoArea', 'cPhotoInput', 'cPhotoStatus', 'cError', EMPTY_C);
  bindPhoto('repair', 'rPhotoArea', 'rPhotoInput', 'rPhotoStatus', 'rError', EMPTY_R);
  bindPhoto('purchase', 'bPhotoArea', 'bPhotoInput', 'bPhotoStatus', 'bError', EMPTY_B);

  function clearPhoto(mode, areaId, inputId, statusId, emptyHtml) {
    photos[mode] = null;
    $(inputId).value = '';
    const area = $(areaId);
    area.classList.remove('has-image');
    area.innerHTML = emptyHtml;
    if (statusId) $(statusId).classList.add('hidden');
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

  // ── Collection — New Item ──
  $('cSaveBtn').onclick = async () => {
    setText('cError', ''); setText('cSuccess', '');
    const brand = $('cBrand').value.trim();
    const name = $('cName').value.trim();
    const sku = $('cSku').value.trim();
    if (!brand && !name && !sku && !photos.collection) {
      return setText('cError', 'Add a photo or at least one detail.');
    }
    $('cSaveBtn').disabled = true;
    try {
      const { now, branchId, userId } = ctx();
      const productId = uuid();
      let imageHash = null;
      if (photos.collection) {
        try { imageHash = await computePhash(photos.collection); } catch (e) { console.warn('pHash failed:', e); }
      }
      const productData = {
        id: productId, branch_id: branchId,
        category_id: $('cCategory').value || 'cat-watch',
        brand, name,
        sku: sku || null,
        quantity: 1, condition: '', scope_of_delivery: '[]',
        purchase_date: now.split('T')[0],
        purchase_price: parseFloat($('cPurchasePrice').value) || 0,
        purchase_currency: 'BHD',
        planned_sale_price: parseFloat($('cSalePrice').value) || null,
        stock_status: 'in_stock', tax_scheme: 'MARGIN', source_type: 'OWN',
        notes: $('cNotes').value.trim() || null,
        images: JSON.stringify(photos.collection ? [photos.collection] : []),
        image_hash: imageHash,
        attributes: '{}', created_at: now, updated_at: now, created_by: userId,
      };
      await pushChanges([{ table_name: 'products', record_id: productId, action: 'insert', data: JSON.stringify(productData) }]);
      const label = (brand + ' ' + name).trim() || sku || 'Item';
      setText('cSuccess', label + ' saved. It appears on the desktop within 30 seconds.');
      $('cBrand').value = ''; $('cName').value = ''; $('cSku').value = '';
      $('cPurchasePrice').value = ''; $('cSalePrice').value = ''; $('cNotes').value = '';
      clearPhoto('collection', 'cPhotoArea', 'cPhotoInput', 'cPhotoStatus', EMPTY_C);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e.message !== 'Session expired') setText('cError', e.message || 'Save failed');
    }
    $('cSaveBtn').disabled = false;
  };

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
</html>"##;

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
