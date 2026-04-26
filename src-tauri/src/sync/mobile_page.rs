// Self-contained mobile product-capture page served at /mobile.
// Pure HTML/JS/CSS, zero build step. Works on any mobile browser in LAN.

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
  .brand { text-align: center; margin: 24px 0 32px; }
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
  .gross { color: #C6A36D; font-size: 18px; font-weight: 600; }
  .header-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .header-row .badge { background: rgba(126,170,110,0.08); color: #7EAA6E; padding: 4px 10px; border-radius: 999px; font-size: 11px; }
</style>
</head>
<body>

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

<div id="capture" class="hidden">
  <div class="brand">
    <h1>LATAIF</h1>
    <p>New Product</p>
  </div>

  <div id="captureError" class="error hidden"></div>
  <div id="captureSuccess" class="success hidden"></div>

  <div class="card">
    <div class="header-row">
      <span style="font-size: 13px; color: #A1A1AA;">Photo</span>
      <span id="photoStatus" class="badge hidden">Captured</span>
    </div>
    <label for="photoInput" class="photo-area" id="photoArea">
      <div class="icon">📷</div>
      <div>Tap to take photo</div>
      <div class="hint">or choose from gallery</div>
    </label>
    <input id="photoInput" class="hidden" type="file" accept="image/*" capture="environment" />
  </div>

  <div class="card">
    <div class="row">
      <label>Category *</label>
      <select id="category" style="background:#121216;color:#E5E1D6;border:1px solid #2A2A30;border-radius:6px;padding:10px 12px;font-size:14px;width:100%;">
        <option value="cat-watch">Watch</option>
        <option value="cat-gold-jewelry">Gold Jewelry</option>
        <option value="cat-branded-gold-jewelry">Branded Gold Jewelry</option>
        <option value="cat-original-gold-jewelry">Original Gold Jewelry</option>
        <option value="cat-accessory">Accessory</option>
        <option value="cat-spare-part">Spare Part</option>
      </select>
    </div>
    <div class="row">
      <label>Brand *</label>
      <input id="brand" type="text" placeholder="e.g. Rolex" />
    </div>
    <div class="row">
      <label>Model / Name *</label>
      <input id="name" type="text" placeholder="e.g. Submariner Date" />
    </div>
    <div class="row">
      <label>SKU / Reference</label>
      <input id="sku" type="text" placeholder="optional" />
    </div>
    <div class="row">
      <label>Purchase Price (BHD)</label>
      <input id="purchasePrice" type="number" inputmode="decimal" step="0.01" placeholder="0.00" />
    </div>
    <div class="row">
      <label>Asking Price (BHD)</label>
      <input id="salePrice" type="number" inputmode="decimal" step="0.01" placeholder="0.00" />
    </div>
    <div class="row">
      <label>Notes</label>
      <textarea id="notes" rows="3" placeholder="Condition, supplier, etc."></textarea>
    </div>
  </div>

  <button id="saveBtn">Save Product</button>
  <a href="#" class="logout" id="logoutLink">Sign out</a>
</div>

<script>
(function () {
  const TOKEN_KEY = 'lataif_mobile_token';
  const BRANCH_KEY = 'lataif_mobile_branch';

  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');
  const setText = (id, t) => { const el = $(id); el.textContent = t; if (t) el.classList.remove('hidden'); else el.classList.add('hidden'); };

  let photoDataUrl = null;

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function init() {
    if (localStorage.getItem(TOKEN_KEY)) {
      show('capture'); hide('login');
    } else {
      show('login'); hide('capture');
    }
  }

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
      localStorage.setItem(BRANCH_KEY, data.branch_id);
      hide('login'); show('capture');
    } catch (e) {
      setText('loginError', e.message || 'Login failed');
    }
    $('loginBtn').disabled = false;
  };

  $('logoutLink').onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(BRANCH_KEY);
    init();
  };

  // Foto auf max 1600px verkleinern + auf 0.85 JPEG komprimieren bevor speichern.
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

  $('photoInput').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      photoDataUrl = await resizePhoto(file, 1600, 0.85);
      const area = $('photoArea');
      area.innerHTML = '';
      area.classList.add('has-image');
      const img = document.createElement('img');
      img.src = photoDataUrl;
      area.appendChild(img);
      $('photoStatus').classList.remove('hidden');
    } catch (err) {
      setText('captureError', 'Photo could not be loaded');
    }
  };

  $('saveBtn').onclick = async () => {
    setText('captureError', '');
    setText('captureSuccess', '');
    const brand = $('brand').value.trim();
    const name = $('name').value.trim();
    if (!brand || !name) return setText('captureError', 'Brand and Name are required.');

    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { init(); return; }

    $('saveBtn').disabled = true;
    try {
      const productId = uuid();
      const now = new Date().toISOString();
      const branchId = localStorage.getItem(BRANCH_KEY) || 'branch-main';
      // Snake_case matching the desktop products table schema. All required columns included.
      const productData = {
        id: productId,
        branch_id: branchId,
        category_id: $('category').value || 'cat-watch',
        brand,
        name,
        sku: $('sku').value.trim() || null,
        quantity: 1,
        condition: '',
        scope_of_delivery: '[]',
        purchase_date: now.split('T')[0],
        purchase_price: parseFloat($('purchasePrice').value) || 0,
        purchase_currency: 'BHD',
        planned_sale_price: parseFloat($('salePrice').value) || null,
        stock_status: 'in_stock',
        tax_scheme: 'MARGIN',
        source_type: 'OWN',
        notes: $('notes').value.trim() || null,
        images: JSON.stringify(photoDataUrl ? [photoDataUrl] : []),
        attributes: '{}',
        created_at: now,
        updated_at: now,
      };

      const res = await fetch('/api/sync/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          changes: [{
            table_name: 'products',
            record_id: productId,
            action: 'insert',
            data: JSON.stringify(productData),
          }],
        }),
      });

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        init();
        setText('loginError', 'Session expired. Please sign in again.');
        return;
      }
      if (!res.ok) throw new Error('Save failed: ' + res.status);

      setText('captureSuccess', brand + ' ' + name + ' saved. It will appear on the desktop within 30 seconds.');
      // Reset form
      $('brand').value = '';
      $('name').value = '';
      $('sku').value = '';
      $('purchasePrice').value = '';
      $('salePrice').value = '';
      $('notes').value = '';
      $('photoInput').value = '';
      photoDataUrl = null;
      const area = $('photoArea');
      area.classList.remove('has-image');
      area.innerHTML = '<div class="icon">📷</div><div>Tap to take photo</div><div class="hint">or choose from gallery</div>';
      $('photoStatus').classList.add('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setText('captureError', e.message || 'Save failed');
    }
    $('saveBtn').disabled = false;
  };

  init();
})();
</script>
</body>
</html>"##;
