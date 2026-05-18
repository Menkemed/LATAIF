// ═══════════════════════════════════════════════════════════
// LATAIF — AI Service (OpenAI)
// Product recognition, text generation, price suggestions
// ═══════════════════════════════════════════════════════════

const STORAGE_KEY = 'lataif_openai_key';
const MODEL_KEY = 'lataif_openai_model';

// Security-Hardening (Plan §QA #11):
// 1) In Tauri persistieren wir den Key in `%APPDATA%/lataif/openai.key` (User-level permission)
//    statt in localStorage (von DOM-Code lesbar via XSS).
// 2) Light-Obfuscation (XOR + base64) damit der Key nicht als plaintext im Disk-Dump erscheint.
//    Dies ist KEIN echter Schutz gegen lokale Angreifer — Roadmap: Tauri-Stronghold-Plugin.
// 3) Cache nur in-memory; nicht synchron aus localStorage lesen.
const OBF_SEED = 'lataif-2026-key-obf';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function obfuscate(plain: string): string {
  if (!plain) return '';
  let out = '';
  for (let i = 0; i < plain.length; i++) {
    out += String.fromCharCode(plain.charCodeAt(i) ^ OBF_SEED.charCodeAt(i % OBF_SEED.length));
  }
  return btoa(out);
}
function deobfuscate(blob: string): string {
  if (!blob) return '';
  try {
    const raw = atob(blob);
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      out += String.fromCharCode(raw.charCodeAt(i) ^ OBF_SEED.charCodeAt(i % OBF_SEED.length));
    }
    return out;
  } catch { return ''; }
}

let _apiKeyCache: string | null = null;

async function readKeyFromTauri(): Promise<string> {
  try {
    const { appDataDir, join } = await import('@tauri-apps/api/path');
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    const dir = await appDataDir();
    const path = await join(dir, 'openai.key');
    if (!(await exists(path))) return '';
    const blob = await readTextFile(path);
    return deobfuscate(blob.trim());
  } catch { return ''; }
}

async function writeKeyToTauri(key: string): Promise<void> {
  try {
    const { appDataDir, join } = await import('@tauri-apps/api/path');
    const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const dir = await appDataDir();
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    const path = await join(dir, 'openai.key');
    await writeTextFile(path, obfuscate(key));
  } catch (e) { console.warn('[ai] failed to persist key to Tauri:', e); }
}

export function getApiKey(): string {
  if (_apiKeyCache !== null) return _apiKeyCache;
  // Browser-Fallback: obfuscated in localStorage (besser als plain).
  const blob = localStorage.getItem(STORAGE_KEY) || '';
  _apiKeyCache = blob.startsWith('sk-') ? blob /* legacy plaintext */ : deobfuscate(blob);
  // Migration: wenn legacy plaintext gefunden, sofort obfuskiert ablegen.
  if (blob.startsWith('sk-')) {
    localStorage.setItem(STORAGE_KEY, obfuscate(blob));
    if (isTauri()) writeKeyToTauri(blob);
  }
  // Async Re-Load aus Tauri (überschreibt Cache wenn Tauri-File existiert und neuer ist).
  if (isTauri() && !_apiKeyCache) {
    readKeyFromTauri().then(k => { if (k) _apiKeyCache = k; });
  }
  return _apiKeyCache || '';
}

export function setApiKey(key: string) {
  _apiKeyCache = key;
  // Browser-Storage immer obfuskiert.
  localStorage.setItem(STORAGE_KEY, obfuscate(key));
  // Tauri zusätzlich in app-data dir (OS-User-Permission).
  if (isTauri()) writeKeyToTauri(key);
}

export function clearApiKey() {
  _apiKeyCache = null;
  localStorage.removeItem(STORAGE_KEY);
  if (isTauri()) {
    (async () => {
      try {
        const { appDataDir, join } = await import('@tauri-apps/api/path');
        const { remove, exists } = await import('@tauri-apps/plugin-fs');
        const dir = await appDataDir();
        const path = await join(dir, 'openai.key');
        if (await exists(path)) await remove(path);
      } catch { /* */ }
    })();
  }
}

export function getModel(): string {
  return localStorage.getItem(MODEL_KEY) || 'gpt-4o';
}

export function setModel(model: string) {
  localStorage.setItem(MODEL_KEY, model);
}

export function isAiConfigured(): boolean {
  return getApiKey().startsWith('sk-');
}

// ── OpenAI API Call ──

async function callOpenAI(messages: { role: string; content: any }[], maxTokens = 1000, temperature = 0.3): Promise<string> {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: getModel(),
      messages,
      max_tokens: maxTokens,
      temperature,
      // store: false prevents the request/response from being persisted in OpenAI's logs
      // (regardless of account-level data retention). Luxury customer data.
      store: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices[0]?.message?.content || '';
}

// ── Raw chat for tool-calling (used by Reports natural-language chat) ──

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export async function callOpenAIWithTools(
  messages: ChatCompletionMessage[],
  tools: ToolDefinition[],
  maxTokens = 1500,
  temperature = 0.2,
): Promise<ChatCompletionMessage> {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: getModel(),
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: maxTokens,
      temperature,
      store: false,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.choices[0]?.message || { role: 'assistant', content: '' };
}

// ═══════════════════════════════════════════════════════════
// AI FEATURES
// ═══════════════════════════════════════════════════════════

// ── 1. Product Recognition from Image ──

export interface ProductRecognition {
  brand?: string;
  name?: string;
  referenceNo?: string;
  serialNo?: string;
  dial?: string;
  caseMaterial?: string;
  caseSize?: number;
  movement?: string;
  year?: number;
  condition?: string;
  material?: string;
  color?: string;
  estimatedValue?: number;
  description?: string;
}

export async function recognizeProduct(imageBase64: string): Promise<ProductRecognition> {
  const response = await callOpenAI([
    {
      role: 'system',
      content: `You are a world-class luxury watch and goods authentication expert with 30 years of experience.
You work for auction houses like Christie's, Sotheby's, and Phillips.

For WATCHES you must identify:
- The EXACT reference number (e.g. Rolex 6062, not just "Oyster Perpetual")
- The collector nickname if it has one (e.g. "Dark Star", "Paul Newman", "Pepsi", "Batman", "Hulk")
- The specific variant and year range
- Complications visible (moonphase, chronograph, date, day-date, GMT, etc.)
- Case material from patina/color (steel, gold, rose gold, platinum, two-tone)
- Dial details (color, indices type, lume type)
- Condition assessment (mint, excellent, good, fair, poor, vintage patina)

For JEWELRY: identify maker, collection, metal, stones, carat if visible.
For BAGS: identify maker, model, leather type, hardware, size, color.

Be EXTREMELY specific. Never give generic names like "Oyster Perpetual Moonphase" when you can identify it as "Ref. 6062 Triple Calendar Moonphase (Dark Star)".

Respond in JSON only, no markdown:
{"brand":"","name":"","referenceNo":"","serialNo":"","dial":"","caseMaterial":"","caseSize":0,"movement":"","year":0,"condition":"","color":"","estimatedValue":0,"description":""}

Fill in ALL fields you can determine from the image:
- brand: manufacturer (e.g. "Rolex")
- name: specific model WITH nickname (e.g. "6062 Triple Calendar Moonphase 'Dark Star'")
- referenceNo: reference number only (e.g. "6062")
- serialNo: if visible on dial/caseback, otherwise ""
- dial: dial description (e.g. "Silver Stelline dial, star markers, day/month windows")
- caseMaterial: case material (e.g. "Yellow Gold", "Stainless Steel", "Rose Gold", "Platinum", "Two-Tone SS/YG")
- caseSize: case diameter in mm (estimate from proportions, e.g. 36, 40, 41)
- movement: caliber if known (e.g. "Cal. 9461", "Cal. 3135")
- year: estimated production year or decade (e.g. 1953, 2021)
- condition: one of "New", "Unworn", "Pre-Owned", "Vintage"
- color: primary color (e.g. "Gold", "Black", "Blue")
- estimatedValue: current market value in BHD (1 BHD = ~2.65 USD)
- description: detailed notes

For jewelry/bags adjust fields accordingly (material=metal/leather, color, etc).
Set to "" or 0 if truly unknown. Never guess serial numbers.`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Identify this luxury item with maximum specificity. Include reference number, collector nickname, and detailed assessment:' },
        { type: 'image_url', image_url: { url: imageBase64 } },
      ],
    },
  ], 500);

  try {
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { description: response };
  }
}

// ── 1b. Category-aware Product Identification (Plan §Product §4: ALL 6 categories) ──
// AI füllt pro Kategorie alle Pflicht- und Optional-Felder aus plus Preis, Condition, Description.

export type AiCategoryId =
  | 'cat-watch'
  | 'cat-gold-jewelry'
  | 'cat-branded-gold-jewelry'
  | 'cat-original-gold-jewelry'
  | 'cat-accessory'
  | 'cat-spare-part';

export interface AiProductIdentification {
  // Universal
  brand?: string;
  name?: string;
  sku?: string;                    // Suggested SKU pattern (e.g. "RLX-SUB-001")
  condition?: string;
  description?: string;
  estimatedValue?: number;         // Market value in BHD
  purchasePriceEstimate?: number;  // What we might pay
  minSalePrice?: number;
  maxSalePrice?: number;
  scopeOfDelivery?: string[];      // ["Box", "Papers", "Certificate"]
  taxScheme?: 'MARGIN' | 'VAT_10' | 'ZERO';  // Suggested scheme based on item type
  storageLocation?: string;        // Suggested storage (e.g. "Safe", "Display Case A")
  notes?: string;
  // Attributes (category-specific — consumer should merge into Product.attributes)
  attributes: Record<string, string | number | boolean | string[]>;
  // Research metadata
  referenceSource?: string;
  marketComparables?: string;
  // Confidence-Self-Rating (2026-05-18) — die AI muss bei jedem Identify
  // bewerten wie sicher sie sich ist. Damit kann die UI 'Needs Confirmation'-
  // Badges anzeigen und der User priorisiert was er reviewt.
  identificationConfidence?: 'high' | 'medium' | 'low';
}

// Plan §Product §4 — category spec for AI prompt generation
const CATEGORY_SPECS: Record<AiCategoryId, {
  name: string;
  required: string[];
  optional: string[];
  conditionOptions: string[];
  scopeOptions: string[];
  notes: string;
}> = {
  'cat-watch': {
    name: 'WATCH',
    // 'model' attribute removed 2026-05-17 — Duplikat zum Universal-Feld name.
    // karat_color hängt von material ab (Gold-Anteil) — vom Caller per dependsOn gefiltert.
    // 2026-05-17: reference_number, serial_number, bezel optional (Vintage/Custom).
    required: ['case_diameter_mm', 'dial', 'material', 'karat_color', 'diamonds', 'strap_type'],
    optional: ['reference_number', 'serial_number', 'bezel', 'movement', 'year', 'description'],
    conditionOptions: ['Unworn', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Papers', 'Warranty Card', 'Extra Links', 'Pouch'],
    notes: [
      'reference_number = the EXACT factory reference (Rolex 4-7 chars like "126610LN", "16610", "126710BLRO"; Patek "5711/1A-010"; AP "15500ST.OO.1220ST.01"; Omega "310.30.42.50.01.001"). NEVER return brand-name or family-name as reference. Read crown engraving / between-lugs / caseback if visible.',
      // Model gehört in den Universal-`name`-Feld, nicht in attributes.
      'NB: the full collector name (with nickname, e.g. "Submariner Date \'Hulk\'", "GMT-Master II \'Pepsi\'", "Daytona \'Paul Newman\'", "Royal Oak Jumbo", "Nautilus 5711") goes into the top-level "name" field, NOT into attributes.',
      'case_diameter_mm = case width in millimetres (number only, e.g. 36, 40, 41, 42). Estimate from proportions vs crown/lugs if not stated. Common sizes: Submariner 40-41, Datejust 36/41, Daytona 40, GMT 40, Nautilus 40, Royal Oak 39-41, AP Offshore 42-44, Speedmaster 42. NEVER guess wider than 50.',
      'material ∈ {Steel, Solid Gold, Two-Tone Steel/Gold, Platinum, Titanium, Ceramic, Bronze, Carbon, DLC Steel, Plated, Ceramic & Steel, Ceramic & Gold, Titanium & Gold, Titanium & Ceramic}. karat_color ∈ {18K Yellow, 18K Rose, 18K White, 14K Yellow, 14K Rose, 14K White, 9K Yellow, 9K Rose} — ONLY return this when material has a gold component (Solid Gold, Two-Tone Steel/Gold, Ceramic & Gold, Titanium & Gold); otherwise null. strap_type ∈ {Leather, Rubber}. diamonds is boolean. movement = caliber if visible/known (e.g. "Cal. 3135", "Cal. 9461MC"). year = approximate production year (number).',
    ].join(' '),
  },
  'cat-gold-jewelry': {
    name: 'GOLD_DIAMOND_JEWELRY',
    // 2026-05-17: color_type integriert in karat (z.B. "18K Rose", "14K Mix"). Silver + Bar + Coin hinzu.
    required: ['weight', 'karat', 'item_type'],
    optional: ['diamond_weight', 'description'],
    conditionOptions: ['Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Certificate', 'Pouch'],
    notes: 'weight in grams (number). karat ∈ {24K Yellow, 22K Yellow, 21K Yellow, 18K Yellow, 18K Rose, 18K White, 18K Mix, 14K Yellow, 14K Rose, 14K White, 14K Mix, Silver} — combine karat + color into a single value (24K/22K/21K only exist in Yellow). Mix = Two-Tone. Silver for non-gold silver items. item_type ∈ {Ring, Bangle, Bracelet, Necklace, Pendant, Earrings, Brooch, Bar, Coin} (Bar/Coin for investment-grade pieces). diamond_weight in carats.',
  },
  'cat-branded-gold-jewelry': {
    name: 'BRANDED_GOLD_JEWELRY',
    // 2026-05-17: color_type integriert in karat (z.B. "18K Rose", "14K Mix").
    required: ['item_type', 'size', 'karat'],
    optional: ['weight', 'diamond_weight', 'model_number', 'serial_number', 'certificate', 'box', 'description'],
    conditionOptions: ['New', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Certificate', 'Papers', 'Pouch', 'Receipt'],
    notes: 'karat ∈ {24K Yellow, 22K Yellow, 21K Yellow, 18K Yellow, 18K Rose, 18K White, 18K Mix, 14K Yellow, 14K Rose, 14K White, 14K Mix, Silver} — combine karat + color (Mix = Two-Tone; 24K/22K/21K only Yellow; Silver for non-gold). item_type ∈ {Ring, Bangle, Bracelet, Necklace, Pendant, Earrings, Brooch}. weight in grams (optional). certificate and box are booleans. size can be ring-size or "Small"/"Medium" etc.',
  },
  'cat-original-gold-jewelry': {
    name: 'ORIGINAL_GOLD_JEWELRY',
    // 2026-05-17: color_type integriert in karat.
    required: ['item_type', 'size', 'karat'],
    optional: ['weight', 'diamond_weight', 'description'],
    conditionOptions: ['New', 'Pre-Owned', 'Vintage', 'Antique'],
    scopeOptions: ['Box', 'Certificate', 'Appraisal', 'Pouch'],
    notes: 'karat ∈ {24K Yellow, 22K Yellow, 21K Yellow, 18K Yellow, 18K Rose, 18K White, 18K Mix, 14K Yellow, 14K Rose, 14K White, 14K Mix, Silver} — combine karat + color (Mix = Two-Tone; 24K/22K/21K only Yellow; Silver for non-gold). item_type ∈ {Ring, Bangle, Bracelet, Necklace, Pendant, Earrings, Brooch}. weight in grams (optional). For antique/heritage include provenance in description.',
  },
  'cat-accessory': {
    name: 'ACCESSORY',
    required: ['item_type', 'color', 'material', 'description'],
    optional: ['model_number', 'serial_number', 'box', 'papers'],
    conditionOptions: ['New', 'Pre-Owned'],
    scopeOptions: ['Box', 'Dust Bag', 'Pouch', 'Papers'],
    notes: 'item_type ∈ {Handbag, Eyeglass, Wallet, Lighter, Cufflinks, Prayer Beads, Walking Stick, Pen, Key Holder, Other}. material e.g. "Leather", "Canvas", "Metal". color free text. box and papers are booleans.',
  },
  'cat-spare-part': {
    name: 'SPARE_PART',
    // 'model' attribute removed 2026-05-17 — gehört in den Universal-`name`-Feld.
    // 'karat' integriert in `material` als Select.
    required: ['part_type', 'material', 'original_or_copy', 'description'],
    optional: [],
    conditionOptions: ['New', 'Pre-Owned', 'Refurbished'],
    scopeOptions: ['Packaging'],
    notes: 'The compatible model/family (e.g. "Rolex Submariner Dial", "AP Royal Oak Strap") goes into the top-level "name" field. part_type ∈ {Dial, Bezel, Links, Crown, Strap, Buckle, Caseback, Movement, Crystal, Box, Other}. material ∈ {Steel, 18K YG, 18K RG, 18K WG, 14K YG, 14K RG, 14K WG, Steel/18K YG, Steel/18K RG, Steel/18K WG, Steel/14K YG, Steel/14K RG, Steel/14K WG} — YG/RG/WG = Yellow/Rose/White Gold; Steel/<gold> = Bicolor (e.g. Rolesor links). original_or_copy ∈ {Original, Copy}.',
  },
};

export async function identifyProduct(params: {
  categoryId: AiCategoryId;
  imageBase64?: string;          // optional — if present, use vision
  hints?: {                      // optional — text hints from user
    brand?: string;
    name?: string;
    reference?: string;
    serial?: string;
    notes?: string;
  };
  /** 2026-05-18 — Few-Shot-Block mit User-Korrekturen, wird direkt in den
   *  System-Prompt injected damit die AI aus deinen Bestaetigungen lernt.
   *  Aufbau via getRecentCorrectionsAsPrompt(brand, categoryId). */
  recentCorrections?: string;
}): Promise<AiProductIdentification> {
  const spec = CATEGORY_SPECS[params.categoryId];
  if (!spec) throw new Error(`Unknown category: ${params.categoryId}`);

  const hintsText = params.hints
    ? Object.entries(params.hints).filter(([, v]) => !!v).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';

  const systemPrompt = `You are a world-class luxury goods appraiser and authentication expert with 30 years of experience at Christie's, Sotheby's, and Phillips.
Specialize in watches, fine jewelry, designer bags, accessories, and spare parts.

Your task: identify this ${spec.name} item with EXTREME specificity and research-grade accuracy.

**Category**: ${spec.name}
**Required attributes to fill**: ${spec.required.join(', ')}
**Optional attributes**: ${spec.optional.join(', ')}
**Condition options**: ${spec.conditionOptions.join(' | ')}
**Scope-of-delivery options** (multi-select): ${spec.scopeOptions.join(' | ')}
**Format notes**: ${spec.notes}

**JEWELER MINDSET — DIFFERENTIAL DIAGNOSIS (MANDATORY before any final answer)**:
Think like a watchmaker examining a piece on the bench. Do NOT jump to the first plausible reference.
Process:
1. **Survey** — note ALL visible details: dial color, dial markers (Roman/baton/diamond/Arabic), bezel (smooth/fluted/diamond-set/ceramic), bracelet (Oyster/Jubilee/President/leather/integrated), case material (steel/two-tone/yellow gold/white gold/Everose), lugs (sharp/rounded/integrated), crown guard (yes/no), date window (with/without cyclops), complications (chronograph/GMT/moonphase), hand style.
2. **List 3 plausible candidates** with the canonical references for each. Example: a stainless Datejust with silver dial could be 126200 (smooth bezel, oyster), 126234 (fluted bezel, jubilee), 116200 (older 36mm). For each candidate, state ONE strongest VISUAL discriminator that supports OR refutes it.
3. **Discrimination cues to apply** (specific to common families):
   - **Rolex Datejust 36 vs 41**: 41mm has wider dial-to-bezel ratio + proportionally smaller crown; 36mm has crown taking ~12% of case diameter, classic chest proportions, smaller lugs.
   - **Datejust New (super-case 2010+) vs Old**: New = bolder lugs, "maxi" indices, wider bracelet end-links, crown guard impression even on DJ; Old (pre-2009) = thinner lugs, smaller indices, slimmer overall.
   - **Datejust special editions**: Wimbledon (slate dial + Roman numerals in green/silver), Palm (green palm-leaf pattern dial), Fluted Motif (engraved dial pattern), Mother-of-Pearl (iridescent), Diamond dial (markers replaced by diamonds), Big-Diamond bezel (5-stone or pave) — note all explicitly.
   - **Submariner Hulk (116610LV)** vs **Kermit (16610LV)** vs **Starbucks (126610LV new 41mm)**: Hulk = green dial+green bezel, 40mm, 2010-2020. Kermit = black dial+green bezel, 40mm, 2003-2010. Starbucks = black dial+green bezel modern, 41mm wider case, ceramic bezel, post-2020.
   - **GMT Pepsi vs Coke vs Batman vs Sprite**: red/blue, red/black, black/blue, black/green. Bracelet: Jubilee (126710BLRO/BLNR) or Oyster (126710BLNR/BLRO oyster also exists for some).
   - **Daytona 116500LN vs 116520**: 116500 = ceramic bezel post-2016. 116520 = aluminum bezel 2000-2016 (collectible "APH" dial variants).
   - **Patek Nautilus 5711/1A**: -010 = blue dial, -014 = white dial Tiffany not, -018 = Tiffany-Blue dial (rare), Tiffany & Co cobranded = signature on dial.
   - **AP Royal Oak Jumbo** (15202): 39mm extra-thin tonneau case, integrated bracelet, "Petite Tapisserie" dial; vs **Royal Oak 15500** = 41mm modern, "Grande Tapisserie".
4. **Confidence Self-Rating** — output an extra top-level field "identificationConfidence": one of "high" | "medium" | "low". HIGH = visible reference engraving or all-clear DD-cues match exactly. MEDIUM = strong visual identification but no engraving + 1-2 small features ambiguous. LOW = best-guess from visible features but uncertain on variant. If LOW or worse, prefer null in reference_number and explain in notes.
5. **Output** — in notes field, write a 1-line "DD trail": "Considered: A, B, C. Chose B because: [cue]. Ruled out A because: [cue]. Ruled out C because: [cue]."

**Rules**:
- Identify brand + exact model/reference/collection name — include nicknames where applicable (e.g. "Submariner 'Hulk'", "6062 'Dark Star'", "Cartier Love", "Bulgari Serpenti", "Van Cleef Alhambra")
- **WATCHES (CRITICAL — these three together identify the watch)**:
  1. **reference_number**: the EXACT manufacturer reference. Two valid sources:
     (i) **READ** from visible markings — dial bottom text, caseback engraving, between lugs (Rolex), or papers in the photo.
     (ii) **INFER FROM MODEL** — once you've identified the specific variant visually (dial color, bezel material, generation, complications, hand type), apply your model knowledge to fill the canonical factory reference. This is the COMMON case for casual photos where engraving isn't visible.
     Examples of inferring:
       - Rolex Submariner with green bezel + green dial → 116610LV ("Hulk")
       - Rolex Submariner Date stainless black bezel modern → 126610LN
       - Rolex GMT-Master II with red/blue bezel jubilee bracelet → 126710BLRO ("Pepsi")
       - Patek Nautilus 40mm steel blue dial → 5711/1A-010 (or /1A-018 if Tiffany-blue dial)
       - AP Royal Oak Jumbo Extra-Thin steel blue dial → 15202ST.OO.1240ST
       - Cartier Tank Must Large quartz silver dial steel → WSTA0041 family
       - Datejust 36mm fluted bezel jubilee silver dial → 126234 family; with smooth bezel oyster bracelet → 126200
     NEVER substitute family-name (e.g. "Submariner") for a reference. Format examples by brand:
     - Rolex: 4-6 digits vintage ("1601", "6062") or modern alphanumeric ("126610LN", "126710BLRO", "116500LN")
     - Patek Philippe: with slashes ("5711/1A-010", "5990/1A", "5167A-001")
     - Audemars Piguet: long codes ("15500ST.OO.1220ST.01", "26331ST.OO.1220ST.01")
     - Omega: dotted numerics ("310.30.42.50.01.001", "311.30.42.30.01.005")
     - Cartier: "WSSA0030", "W31044M7", "WGNM0017"
     - Vacheron / Lange / IWC / JLC: 4-7 digit numerics often with letters ("4500V/110A-B128", "IW371417", "Q1378420")
     **Only return null** if you genuinely cannot identify even the model+variant — i.e. the watch is so obscured/unknown that you can't put a specific name in the name field either. If you can identify the variant, ALWAYS attempt the canonical reference. State your inference path in notes (example: "ref inferred from green bezel + green dial + jubilee bracelet → 116610LV Hulk").
  2. **name** (top-level, NOT in attributes — the exact collector name): include the family AND the nickname/variant (e.g. "Submariner Date 'Hulk'", "GMT-Master II 'Pepsi'", "Daytona 'Panda'", "Royal Oak Jumbo Extra-Thin", "Nautilus 5711/1A 'Tiffany'"). NEVER just "Submariner" — always specify the variant.
  3. **case_diameter_mm**: case width in mm — DETERMINED, NEVER GUESSED. Priority order:
     **(a) REFERENCE-DRIVEN** — if you read a reference number, the size is FIXED by that reference. Apply this lookup table strictly:
        Rolex: 116610LN/126610LN=40/41, 124060=41, 126613=41, 116710/126710=40, 116500/126500=40, 116500/126500=40, 116519=40, 126200=36, 126233/126234=36, 126331/126333/126334=41, 126710BLRO=40, 126281=36, 126331=41, 126301=41, 116200/116234=36, 178200/178240=31, 116000=36, 6541=36 (vintage), 6062=36 (vintage), 1601/1603=36, 1675=40, 5512/5513=40, 5500=34, 1500=34, 1700=36, GMT-Master II 126710=40, Day-Date 36mm=128238/118238/118208, Day-Date 40mm=228238/228239, Datejust 31=178274/178240/178344, Datejust 36=126200/126234/126233/116200/116234/116231, Datejust 41=126300/126301/126331/126333/126334/116300/116333/116334
        Patek: 5711/1A=40, 5712/1A=40.5, 5990/1A=40.5, 5980/1A=40.5, 5167A=40, 5168G=42.2, 5740/1G=40, 6300=44.8, 5212A=40, 5170=39.4, 5524G=42, 5230=38.5
        AP: 15500ST=41, 15400ST=41, 15300ST=39, 15202ST (Jumbo Extra-Thin)=39, 15703ST=42, 26331ST (Chrono)=41, 26240ST=41, 26715ST=37, 26579CE=42, 26420SR=41, Offshore 26170=42, Offshore 26470=42
        Omega: Speedmaster Pro 311.30.42.30=42, Seamaster Diver 300m 210.30.42=42, Seamaster Aqua Terra 220.10.41=41 / 220.10.38=38 / 220.10.34=34, Constellation 131.10.39=39 / 131.10.36=36 / 131.10.29=29
        Cartier: Tank Must Large=33.7x25.5, Tank Must Medium=31x27, Tank Must Small=28x22, Tank Solo Medium=31x27, Santos Medium=35.1x41.9, Santos Large=39.8x47.5, Panthere Medium=27, Panthere Large=27, Ballon Bleu 36=36 / 33=33 / 28=28, Roadster=37 (Medium)
        IWC: Portugieser 7-Day=42.3 (IW500107), Portofino 40=40 (IW356501), Big Pilot 43=43 (IW501001/IW329301), Aquatimer 42=42, Mark XX=40
        JLC: Reverso Tribute Small Seconds=45.6x27.4, Reverso Classic Medium=40x24.4, Master Ultra Thin Small Seconds 39=39 / 36=36 / 34=34, Polaris Date=42
        Lange: Lange 1=38.5, Lange 1 Small=36.8, Saxonia Thin 37=37 / 39=39, Datograph=39 / 41=41, Odysseus=40.5
        Vacheron: Patrimony 36=36 / 40=40 / 42=42, Overseas 41=41 / 35=35, Traditionnelle=38 / 39 / 40 / 41 / 42 / 44 (per ref)
        Tudor: BB Pro=39, BB58=39, BB GMT=41, BB36=36, BB41=41, BB54=37, Pelagos=42, Pelagos 39=39, Royal=28/34/38/41 per ref
     **(b) VISUAL PROPORTION** — if reference is NOT readable, measure from the photo: lug-to-lug span vs. wrist or strap width gives you ratio. Crown size, dial vs case ratio. State your visual evidence in the notes field. Confidence range ±1mm acceptable.
     **(c) NEVER DO**: do NOT default to 40, do NOT round to "40-41", do NOT skip the field. If you cannot decide, return null AND state in notes "case_diameter_mm: unclear — needs caliper measurement".
     **(d) RELATIVE GEOMETRY — MANDATORY** (measure these from the image, write the ratios as decimals in notes field):
        - bezel_dial_ratio = bezel-outer-diameter / dial-opening-diameter. Sport models (Sub/GMT/Daytona) ~1.18-1.22; dress (Datejust 36) ~1.10-1.14; Datejust 41 ~1.12-1.15.
        - crown_case_ratio = crown-diameter / case-diameter. 36mm DJ ~0.115-0.125 (visually prominent crown); 41mm DJ ~0.095-0.105 (smaller-looking crown); Submariner 40 ~0.095; AP Royal Oak ~0.085.
        - lug_case_ratio = lug-tip-to-tip / case-diameter. Modern Rolex sport ~1.18-1.20; modern DJ ~1.20; Patek Nautilus 5711 ~1.20 (flat ears); AP Royal Oak ~1.27 (integrated bracelet); IWC Portugieser ~1.20.
        - date_window_ratio = date-window-width / dial-radius. Rolex cyclops 3-o'clock ~0.18-0.22 (large magnified); Patek/AP unmagnified ~0.10-0.12.
        Use these ratios as PRIMARY size-discriminator: if measured crown_case_ratio >= 0.115 → likely 36mm DJ, if <= 0.105 → likely 41mm DJ.
     **(e1) LUGS — MANDATORY EXAMINATION** (specific lug profile distinguishes generations):
        - **Lug-tip-to-tip span**: state in mm (e.g. "lugs ~48mm tip-to-tip on a 41mm case = lug ratio 1.17"). Use this AS PRIMARY scale anchor when wrist not visible.
        - **Lug shape**: sharp-edged vs polished-rounded vs integrated. Rolex pre-2010 = thinner/sharper lugs; "super-case" 2010+ = thicker/wider lugs with polished bevels. Patek Nautilus = horizontal "ears" (flat-topped, integrated). AP Royal Oak = no separate lugs, case extends into bracelet (octagonal bezel screws). IWC Portugieser = thin straight lugs, no bevel.
        - **Lug width (where the strap attaches)**: critical for reference identification — Rolex DJ36 = 20mm strap, DJ41 = 21mm strap, Sub 40 = 20mm, Sub 41 (126610) = 21mm, AP Jumbo = 21mm integrated, Patek Nautilus = 21mm integrated, Speedmaster Pro = 20mm. Measure strap-width-vs-case visually and use as cross-check.
     **(e2) CROWN / WINDER — MANDATORY EXAMINATION**:
        - **Crown shape + signing**: Rolex modern = fluted edges with raised coronet (crown emblem) on top — count the small dots below the coronet: 3 dots = Triplock (sport models / dive watches), 1 dot = Twinlock (dress / Datejust). Omega = "Ω" symbol on crown. Cartier = blue spinel cabochon (Tank, Santos). IWC = polished disc. Patek = engraved Calatrava-cross.
        - **Crown guard**: Submariner / GMT / Daytona / DeepSea = pronounced crown shoulders flanking the crown. Datejust / Day-Date / Explorer = NO crown guard. If you see crown guard → never Datejust. If no crown guard → never Sub/GMT.
        - **Screw-down vs Push-pull**: water-resistant sport models have screw-down crowns (visible thread pattern when partially unscrewed); dress watches have push-pull.
     **(e3) SWISS-MADE SIGNATURE — MANDATORY at 6 o'clock**:
        - Rolex modern: "SWISS MADE" with a tiny coronet (crown ♛ symbol) BETWEEN "SWISS" and "MADE" — this is the genuine maker's mark since ~2008. If you see this, it's a real modern Rolex.
        - Rolex vintage: just "SWISS" alone (pre-1971 with tritium dots) or "T SWISS T" (tritium, 1971-1998) or "SWISS — T < 25" (post-1971).
        - Patek Philippe: "PATEK PHILIPPE" + "GENEVE" on dial, "SWISS" small at 6, sometimes "PP" hallmark on caseback.
        - AP: "SWISS MADE" at 6 in same script as Royal Oak applied logo.
        - Omega: "SWISS MADE" without symbol; case has "Ω" hallmark.
        - Cartier: "SWISS MADE" stamped at bottom + secret signature near 7 (anti-counterfeit) on Roman numeral VII.
        State EXPLICITLY in notes which Swiss-Made signature you observed and what brand it confirms. If the signature contradicts the brand you concluded, lower confidence to "low" and reconsider.
     **(e) WRIST + STRAP CONTEXT — calibration anchors** (if visible, use as scale):
        - On-wrist photo: average male wrist width = 17cm, female = 15cm. Measure watch case width as fraction of wrist width visible. E.g. case spans 45% of a 17cm wrist → ~38mm. Cross-check with model defaults.
        - Strap-only / flat photo: standard lug widths by case size — 36mm case→ 20mm strap (Rolex DJ36 = 20mm), 40-41mm case → 20-21mm (Sub/GMT = 20mm, DJ41 = 21mm), Royal Oak Jumbo 39 = 21mm integrated. Measure strap width relative to case to derive case mm.
        - Camera distance / perspective: if image is shot top-down (orthographic) the ratios above are reliable; if angled, dial appears compressed — account for foreshortening and prefer reference-derived size.
        Write your chosen calibration anchor in notes ("scale anchor: 17cm wrist" or "scale anchor: 20mm strap").
     **(f) DISTINCTIVE 41 vs 36 GUIDE** (Datejust pain point, summary): apply (d) + (e). 36mm DJ has visually prominent crown (crown_case_ratio ~0.12, classic dial-marker-to-edge gap), 41mm DJ has more-square dial-vs-bezel proportion (bezel_dial_ratio ~1.13) with proportionally smaller crown. Count 5-minute markers vs dial edge gap as tie-breaker.
  4. Plus: caliber/movement, year range, complications (chronograph, GMT, moonphase, day-date, perpetual calendar), dial color + indices, bezel material, strap type.
- For branded jewelry: maker, collection, variant, metal, stones
- For unbranded gold: weight (estimate from image), karat (estimate), craft style
- For accessories: maker, collection, leather/material, hardware, edition
- For spare parts: put the compatible model/family into the top-level "name" field; include generation, original vs aftermarket
- Research current market value in BHD (1 BHD ≈ 2.65 USD). Provide realistic mid-market price for Bahrain/GCC.
- Purchase price estimate: what a dealer might pay (usually 60-75% of market value)
- Min/Max sale price: reasonable floor/ceiling for our resale
- Scope-of-delivery: infer from image (visible box, papers, etc.) and return only items from the provided list
- Description: professional 2-4 sentence catalog copy highlighting key features, market positioning, target audience
- Notes: anything noteworthy for internal tracking (condition details, provenance hints, authenticity flags)

**SKU suggestion**: propose a short uppercase SKU pattern: 3-letter brand-code + 3-letter model/type-code + 3-digit running number "001" — e.g. Rolex Submariner → "RLX-SUB-001", Cartier Love → "CAR-LOV-001", Hermes Birkin → "HER-BIR-001", generic gold necklace → "GLD-NCK-001", Paul Newman dial spare part → "RLX-DIA-001". Never reuse an obvious fake/serial — this is an internal reference, not the real serial.

**Tax scheme suggestion**: MARGIN for pre-owned/vintage/second-hand (most luxury resale), VAT_10 for brand-new retail items, ZERO for exempt (rare — exported goods etc). Default to MARGIN when unsure.

**Storage location suggestion**: short hint based on item — "Safe" for high-value watches/jewelry, "Display Case A" for accessories, "Parts Drawer" for spare parts.

Respond with JSON ONLY, no markdown. Structure:
{
  "brand": "",
  "name": "",
  "sku": "",
  "condition": "",
  "description": "",
  "estimatedValue": 0,
  "purchasePriceEstimate": 0,
  "minSalePrice": 0,
  "maxSalePrice": 0,
  "scopeOfDelivery": [],
  "taxScheme": "MARGIN",
  "storageLocation": "",
  "notes": "",
  "referenceSource": "",
  "marketComparables": "",
  "identificationConfidence": "medium",
  "attributes": { ${spec.required.map(k => `"${k}": null`).concat(spec.optional.map(k => `"${k}": null`)).join(', ')} }
}

Set fields to null/empty ONLY if truly indeterminable. Never guess serial numbers. For numeric fields (weight, karat numerical like "18K"→18, caseSize, year, price) return numbers, not strings. For booleans (diamonds, box, papers, certificate) return true/false. For selects return the exact string from the allowed options.`;

  const watchExtra = params.categoryId === 'cat-watch'
    ? '\n\nFor this WATCH, the three CRITICAL fields are reference_number (exact factory ref like "126610LN", not "Submariner"), the top-level "name" field (full collector name including nickname like "Submariner Date \'Hulk\'" — NOT inside attributes), and case_diameter_mm (numeric mm of the case). Look carefully at: dial bottom text, caseback engravings, between-lugs marking, crown engraving, papers/box if visible. If you cannot read the reference, infer it from dial config + bezel + case + hands combination. Never return a family name as the reference.'
    : '';

  const userContent: any[] = [];
  if (hintsText) {
    userContent.push({ type: 'text', text: `User-provided hints:\n${hintsText}\n\nIdentify the item and fill out ALL category fields for "${spec.name}".${watchExtra}` });
  } else {
    userContent.push({ type: 'text', text: `Identify this ${spec.name} item and fill out ALL category fields. Use every visual detail you can extract.${watchExtra}` });
  }
  if (params.imageBase64) {
    userContent.push({ type: 'image_url', image_url: { url: params.imageBase64 } });
  }

  // AI-Learning: User-Korrekturen aus der Vergangenheit als Few-Shot-Suffix
  // an den System-Prompt anhaengen. Wenn leer → unveraendert.
  const fullSystemPrompt = systemPrompt + (params.recentCorrections || '');

  const response = await callOpenAI(
    [
      { role: 'system', content: fullSystemPrompt },
      { role: 'user', content: userContent.length > 1 ? userContent : userContent[0].text },
    ],
    1200,
    0.2
  );

  try {
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    // Ensure attributes object exists
    if (!parsed.attributes || typeof parsed.attributes !== 'object') parsed.attributes = {};
    // Sanitize: OpenAI sometimes returns literal "null" or "" strings. Convert to undefined.
    const sanitizeStr = (v: unknown): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'n/a' || t === '-') return undefined;
      return t;
    };
    parsed.brand = sanitizeStr(parsed.brand);
    parsed.name = sanitizeStr(parsed.name);
    parsed.sku = sanitizeStr(parsed.sku);
    parsed.condition = sanitizeStr(parsed.condition);
    parsed.description = sanitizeStr(parsed.description);
    parsed.storageLocation = sanitizeStr(parsed.storageLocation);
    parsed.notes = sanitizeStr(parsed.notes);
    parsed.referenceSource = sanitizeStr(parsed.referenceSource);
    parsed.marketComparables = sanitizeStr(parsed.marketComparables);
    // taxScheme must be one of the enum values
    const ts = sanitizeStr(parsed.taxScheme);
    parsed.taxScheme = (ts === 'MARGIN' || ts === 'VAT_10' || ts === 'ZERO') ? ts : undefined;
    // Attributes: also sanitize "null" strings inside
    for (const k of Object.keys(parsed.attributes)) {
      const v = parsed.attributes[k];
      if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'null' || v.trim().toLowerCase() === 'n/a')) {
        delete parsed.attributes[k];
      }
    }
    return parsed as AiProductIdentification;
  } catch {
    // AI returned prose instead of JSON — usually because category is wrong.
    // Wirf einen Fehler mit dem Text, damit die UI alertet statt die Notes zu überschreiben.
    const hint = response.length > 200 ? response.slice(0, 200) + '…' : response;
    throw new Error(`AI konnte Item nicht in dieser Kategorie identifizieren. Versuch eine andere Kategorie. Hint: ${hint}`);
  }
}

// ── 2. Generate Offer Text ──

export async function generateOfferText(params: {
  customerName: string;
  items: { brand: string; name: string; price: number }[];
  total: number;
  language?: string;
}): Promise<string> {
  const itemList = params.items.map(i => `- ${i.brand} ${i.name}: ${i.price} BHD`).join('\n');

  const response = await callOpenAI([
    {
      role: 'system',
      content: `You write professional, elegant offer messages for a luxury goods trading company in Bahrain.
Keep it short (3-5 sentences), warm but professional. Language: ${params.language || 'English'}.
Do not use markdown. Plain text only.`,
    },
    {
      role: 'user',
      content: `Write an offer message for ${params.customerName}:\n${itemList}\nTotal: ${params.total} BHD`,
    },
  ], 300);

  return response;
}

// ── 3. Price Suggestion ──

export async function suggestPrice(params: {
  brand: string;
  name: string;
  condition: string;
  purchasePrice: number;
  attributes?: Record<string, unknown>;
}): Promise<{
  suggestedPrice: number;
  minPrice: number;
  maxPrice: number;
  reasoning: string;
}> {
  const attrs = params.attributes ? Object.entries(params.attributes).map(([k, v]) => `${k}: ${v}`).join(', ') : '';

  const response = await callOpenAI([
    {
      role: 'system',
      content: `You are a luxury goods pricing expert for the Bahrain/GCC market.
Given product details and purchase price, suggest a sale price range.
Respond in JSON only: {"suggestedPrice":0,"minPrice":0,"maxPrice":0,"reasoning":""}
All prices in BHD. Consider brand prestige, condition, market demand.`,
    },
    {
      role: 'user',
      content: `Brand: ${params.brand}\nModel: ${params.name}\nCondition: ${params.condition}\nPurchase Price: ${params.purchasePrice} BHD\n${attrs ? `Details: ${attrs}` : ''}`,
    },
  ], 300);

  try {
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { suggestedPrice: params.purchasePrice * 1.3, minPrice: params.purchasePrice * 1.1, maxPrice: params.purchasePrice * 1.5, reasoning: response };
  }
}

// ── 5. Executive Summary (Reports) ──

import type { ReportContext } from '@/core/reports/context';

function fmtMoney(v: number, currency = 'BHD'): string {
  return `${v.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${currency}`;
}

function compactContextForPrompt(ctx: ReportContext): string {
  // Build a compact key-value dump. Names stay (addressed to user himself).
  const cur = ctx.currency;
  const lines: string[] = [];
  lines.push(`ZEITRAUM: ${ctx.period.label}`);
  lines.push(`UMSATZ: gross ${fmtMoney(ctx.revenue.grossRevenue, cur)}, net ${fmtMoney(ctx.revenue.netRevenue, cur)}, profit ${fmtMoney(ctx.revenue.profit, cur)}, marge ${ctx.revenue.marginPct.toFixed(1)}%`);
  lines.push(`RECHNUNGEN: ${ctx.revenue.invoiceCount} (Ø ${fmtMoney(ctx.revenue.avgInvoiceValue, cur)})`);
  if (ctx.previousPeriod) {
    const d = ctx.revenue.grossRevenue - ctx.previousPeriod.grossRevenue;
    const pct = ctx.previousPeriod.grossRevenue > 0 ? (d / ctx.previousPeriod.grossRevenue) * 100 : 0;
    lines.push(`VORPERIODE: gross ${fmtMoney(ctx.previousPeriod.grossRevenue, cur)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%), profit ${fmtMoney(ctx.previousPeriod.profit, cur)}, ${ctx.previousPeriod.invoiceCount} invoices`);
  }
  lines.push(`CASHFLOW: cash ${fmtMoney(ctx.cashflow.cashReceived, cur)}, bank ${fmtMoney(ctx.cashflow.bankReceived, cur)}, card ${fmtMoney(ctx.cashflow.cardReceived, cur)} (fees -${fmtMoney(ctx.cashflow.cardFeesLost, cur)}), tax paid ${fmtMoney(ctx.cashflow.taxPaid, cur)}, net inflow ${fmtMoney(ctx.cashflow.netInflow, cur)}`);
  lines.push(`STOCK: ${ctx.stock.totalItems} items, Einkaufswert ${fmtMoney(ctx.stock.totalPurchaseValue, cur)}, geplanter VK ${fmtMoney(ctx.stock.totalPlannedSaleValue, cur)}, Ø ${ctx.stock.avgDaysInStock.toFixed(0)} days in stock`);
  if (ctx.stock.slowMovers.length > 0) {
    lines.push(`SLOW-MOVERS (>180 Tage): ${ctx.stock.slowMovers.slice(0, 5).map(s => `${s.brand} ${s.name} (${s.daysInStock}d, EK ${fmtMoney(s.purchasePrice, cur)})`).join('; ')}`);
  }
  if (ctx.sales.byBrand.length > 0) {
    lines.push(`TOP-MARKEN: ${ctx.sales.byBrand.slice(0, 5).map(b => `${b.brand} ${b.units}u/${fmtMoney(b.revenue, cur)}/profit ${fmtMoney(b.profit, cur)}`).join('; ')}`);
  }
  if (ctx.sales.topProducts.length > 0) {
    lines.push(`TOP-PRODUKTE: ${ctx.sales.topProducts.map(p => `${p.brand} ${p.name} VK ${fmtMoney(p.salePrice, cur)} profit ${fmtMoney(p.profit, cur)}`).join('; ')}`);
  }
  lines.push(`KUNDEN: ${ctx.customers.active} active, ${ctx.customers.dormant} dormant, ${ctx.customers.newInPeriod} neu in Periode`);
  if (ctx.customers.topByRevenue.length > 0) {
    lines.push(`TOP-KUNDEN: ${ctx.customers.topByRevenue.slice(0, 3).map(c => `${c.name} ${fmtMoney(c.revenue, cur)} (${c.purchaseCount}x)`).join('; ')}`);
  }
  if (ctx.customers.inactiveVips.length > 0) {
    lines.push(`INAKTIVE VIPs: ${ctx.customers.inactiveVips.slice(0, 5).map(v => `${v.name} (VIP${v.vipLevel}, ${v.daysSinceContact}d)`).join('; ')}`);
  }
  lines.push(`OPERATIONS: ${ctx.operations.openRepairs} offene repairs, ${ctx.operations.openOrders} offene orders, ${ctx.operations.overdueInvoices} overdue invoices (${fmtMoney(ctx.operations.overdueAmount, cur)}), ${ctx.operations.openConsignments} aktive consignments (${fmtMoney(ctx.operations.activeConsignmentValue, cur)})`);
  lines.push(`SCHULDEN: uns geschuldet ${fmtMoney(ctx.debts.owedToUs, cur)}, wir schulden ${fmtMoney(ctx.debts.weOwe, cur)}`);
  return lines.join('\n');
}

export async function generateExecutiveSummary(ctx: ReportContext): Promise<string> {
  const data = compactContextForPrompt(ctx);
  const response = await callOpenAI([
    {
      role: 'system',
      content: `Du bist der persönliche Business-Analyst von Elias, der einen Luxushandel (Uhren, Schmuck, Taschen) in Bahrain betreibt.
Du schreibst einen ehrlichen, prägnanten Monatsreview — nur für ihn, nicht für Steuerberater oder Investoren.

Stil:
- Deutsch, du-Form, direkt
- Keine Marketing-Floskeln, keine "herausragenden Kennzahlen"
- Gold ist nicht "absolute Spitzenklasse" sondern "guter Umsatz mit XY Profit"
- Zahlen in BHD, nur relevante, keine vollständigen Tabellen
- Hebe hervor: was funktioniert, was stagniert, was dringend Aufmerksamkeit braucht
- Bei inaktiven VIPs: konkret die Namen nennen mit Vorschlag
- Bei Slow-Movern: Namen + Alter + EK, plus Vorschlag (Preis senken? Agent? Rabatt?)
- Konkrete nächste Aktionen am Ende (2-3 Punkte, keine Liste mit 10)

Struktur:
## Kurzfassung
1-2 Sätze: Wie lief's?

## Zahlen
3-5 wichtigste Zahlen mit Kontext (Vorperiode wenn vorhanden)

## Was lief gut
Konkret. Mit Zahlen.

## Was lief nicht
Konkret. Mit Zahlen. Slow-Mover beim Namen nennen.

## Kunden
Top-Käufer + inaktive VIPs die Follow-Up brauchen.

## Nächste Schritte
2-3 konkrete Aktionen.

Plain-Text mit Markdown-Headlines (## ...). Keine Bullet-Listen für Fließtext.`,
    },
    {
      role: 'user',
      content: `Daten für ${ctx.period.label}:\n\n${data}\n\nSchreib den Review.`,
    },
  ], 1500, 0.4);

  return response;
}

// ── 6. Insight Alerts (auto-detect anomalies) ──

export interface InsightAlert {
  severity: 'info' | 'warning' | 'urgent';
  category: 'customer' | 'stock' | 'finance' | 'operations';
  title: string;
  detail: string;
  suggestedAction: string;
}

export async function generateInsightAlerts(ctx: ReportContext): Promise<InsightAlert[]> {
  const data = compactContextForPrompt(ctx);
  const response = await callOpenAI([
    {
      role: 'system',
      content: `Du bist der operative Assistent von Elias (Luxushandel Bahrain).
Du analysierst den aktuellen Datenstand und findest bis zu 6 WIRKLICH handlungsrelevante Auffälligkeiten.

Erfinde NICHTS. Wenn nichts auffällig ist: leere Liste zurück.

Jede Auffälligkeit:
- severity: "info" (FYI), "warning" (bald handeln), "urgent" (heute handeln)
- category: "customer" | "stock" | "finance" | "operations"
- title: kurze deutsche Headline (max 8 Wörter)
- detail: 1-2 Sätze mit konkreten Zahlen aus den Daten
- suggestedAction: konkrete Aktion als Imperativ, max 12 Wörter

Typische Kandidaten:
- VIP-Kunde > 90 Tage ohne Kontakt → customer/warning → "VIP [Name] seit [X]d ohne Kontakt. Follow-up senden."
- Slow-Mover > 365 Tage → stock/warning → "Rolex XY seit [X] Tagen im Lager, EK [Y]. Preis prüfen oder Agent."
- Überfällige Rechnungen > [Y] BHD → finance/urgent
- Marge fällt vs. Vorperiode → finance/info
- Consignment läuft bald ab → operations/warning
- Viele offene Repairs → operations/info

Antworte NUR mit einem JSON-Array, keine Erklärung, kein Markdown:
[{"severity":"warning","category":"customer","title":"...","detail":"...","suggestedAction":"..."}]
Bei nichts Auffälligem: []`,
    },
    {
      role: 'user',
      content: `Daten (${ctx.period.label}):\n${data}\n\nFinde die Auffälligkeiten.`,
    },
  ], 1200, 0.3);

  try {
    const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed as InsightAlert[] : [];
  } catch {
    return [];
  }
}

// ── 4. Customer Communication Helper ──

export async function generateMessage(params: {
  type: 'follow_up' | 'repair_ready' | 'order_arrived' | 'promotion' | 'thank_you';
  customerName: string;
  details?: string;
  language?: string;
}): Promise<string> {
  const typePrompts: Record<string, string> = {
    follow_up: 'Write a friendly follow-up message about a recent offer or visit.',
    repair_ready: 'Inform the customer their repair is ready for pickup.',
    order_arrived: 'Inform the customer their pre-ordered item has arrived.',
    promotion: 'Write a message about new arrivals or special offers.',
    thank_you: 'Write a thank you message after a purchase.',
  };

  const response = await callOpenAI([
    {
      role: 'system',
      content: `You write WhatsApp-style messages for a luxury goods store in Bahrain.
Keep it short (2-4 sentences), personal, warm. Language: ${params.language || 'English'}.
No markdown, no emojis, plain professional text.`,
    },
    {
      role: 'user',
      content: `${typePrompts[params.type]}\nCustomer: ${params.customerName}\n${params.details || ''}`,
    },
  ], 200);

  return response;
}

// ═══════════════════════════════════════════════════════════
// Plan §Image-Duplicate-Detection (AI-Embedding)
// ───────────────────────────────────────────────────────────
// gpt-4o-mini Vision liefert eine produkt-spezifische Beschreibung; die wird
// dann mit text-embedding-3-small in einen 1536-Dim-Vektor verwandelt. Zwei
// Produkte werden via Cosine-Similarity verglichen — robust gegen Foto-
// Variation (Winkel, Licht) im Gegensatz zu pHash.
// ═══════════════════════════════════════════════════════════

/** Beschreibt ein Produkt-Bild kompakt — speziell auf Identitäts-Merkmale fokussiert. */
export async function describeProductImage(imageBase64: string): Promise<string> {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');
  // gpt-4o-mini fuer Kosten — ist deutlich billiger als gpt-4o und kann
  // Vision. Description zielt auf identifizierende Merkmale ab.
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You describe luxury items (watches, jewelry, accessories) for visual duplicate detection. Output ONE compact paragraph (60-120 words) covering: type of item, brand if visible, dial/face color and layout, case/material color and finish, bezel/bracelet/strap details, dial markers/numbers/sub-dials, distinctive features (chronograph, GMT, date window position, complications), engravings or text visible, condition signals (scratches, wear). NO speculation about value or owner. NO meta-commentary like "this image shows".',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this item for visual duplicate detection.' },
            { type: 'image_url', image_url: { url: imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}` } },
          ],
        },
      ],
      max_tokens: 220,
      temperature: 0.1,
      store: false,
    }),
  });
  if (!res.ok) throw new Error(`describeProductImage failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.choices[0]?.message?.content || '').trim();
}

/** Bettet einen Text in einen 1536-Dim-Vektor ein (text-embedding-3-small). */
export async function embedText(text: string): Promise<number[]> {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');
  if (!text || text.length === 0) throw new Error('embedText: empty text');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000),
      encoding_format: 'float',
    }),
  });
  if (!res.ok) throw new Error(`embedText failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const vec: number[] | undefined = data.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) throw new Error('embedText: no embedding in response');
  return vec;
}

/** End-to-end: Bild → Beschreibung → Embedding. Liefert {description, embedding}. */
export async function computeImageEmbedding(imageBase64: string): Promise<{ description: string; embedding: number[] }> {
  const description = await describeProductImage(imageBase64);
  const embedding = await embedText(description);
  return { description, embedding };
}

// ═══════════════════════════════════════════════════════════
// Pairwise Visual Match (2026-05-18)
// ───────────────────────────────────────────────────────────
// Two-Stage-Retrieval, Salesforce-Pattern:
//   Stage 1: Embedding-Cosine als billiger Pre-Filter (recall) →
//   Stage 2: GPT-4o-mini-Vision bekommt BEIDE Fotos und entscheidet
//            direkt visuell ob es das gleiche physische Produkt ist.
//
// Loest das Embedding-Falsch-Positiv-Problem: text-embedding-3-small
// auf Bild-Beschreibungen misst nur Sprach-Naehe der Texte (zwei "luxury
// watch with black dial" landen nah beieinander auch wenn es verschiedene
// Modelle sind). Vision-LLM kann die echten Identitaets-Merkmale lesen.
//
// Output: { isMatch, confidence, reason }. isMatch=true nur bei
// 'high'-Konfidenz. 'uncertain' wird als "may be related" gezeigt.
// ═══════════════════════════════════════════════════════════

export interface PairwiseVisualMatchResult {
  isMatch: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export async function pairwiseVisualMatch(
  imageABase64: string,
  imageBBase64: string,
): Promise<PairwiseVisualMatchResult> {
  const key = getApiKey();
  if (!key) throw new Error('No API key configured');

  const urlA = imageABase64.startsWith('data:') ? imageABase64 : `data:image/jpeg;base64,${imageABase64}`;
  const urlB = imageBBase64.startsWith('data:') ? imageBBase64 : `data:image/jpeg;base64,${imageBBase64}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a duplicate-detection assistant for a luxury watch + jewellery inventory. You receive TWO product images and must decide if they show the SAME physical product (allowing for angle/light/crop variation, multiple photos of the same item from different sides). DIFFERENT items of the same model = NOT a duplicate. Different colorways/sizes/references = NOT a duplicate. Output STRICT JSON with keys: isMatch (boolean), confidence ("high"|"medium"|"low"), reason (string, ≤120 chars). Be conservative — only return isMatch=true with confidence="high" when you are very sure. Never invent details.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image A and Image B — same physical product? Answer in strict JSON.' },
            { type: 'image_url', image_url: { url: urlA } },
            { type: 'image_url', image_url: { url: urlB } },
          ],
        },
      ],
      max_tokens: 150,
      temperature: 0.0,
      response_format: { type: 'json_object' },
      store: false,
    }),
  });
  if (!res.ok) throw new Error(`pairwiseVisualMatch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(content);
    const conf = String(parsed.confidence || 'low').toLowerCase() as 'high' | 'medium' | 'low';
    return {
      isMatch: !!parsed.isMatch && conf === 'high',
      confidence: conf === 'high' || conf === 'medium' ? conf : 'low',
      reason: String(parsed.reason || '').slice(0, 200),
    };
  } catch {
    return { isMatch: false, confidence: 'low', reason: 'AI response unparseable' };
  }
}

/** Cosine-Similarity zwischen zwei Vektoren. 1.0 = identisch, 0 = orthogonal, -1 = invers. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Threshold-Konstanten. Locker (User-Wahl 2026-05-17): 0.80 = similar, 0.88 = same. */
export const EMBEDDING_SAME_THRESHOLD = 0.88;
export const EMBEDDING_SIMILAR_THRESHOLD = 0.80;

