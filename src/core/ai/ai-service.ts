// ═══════════════════════════════════════════════════════════
// LATAIF — AI Service (OpenAI)
// Product recognition, text generation, price suggestions
// ═══════════════════════════════════════════════════════════

const STORAGE_KEY = 'lataif_openai_key';
const MODEL_KEY = 'lataif_openai_model';

export function getApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) || '';
}

export function setApiKey(key: string) {
  localStorage.setItem(STORAGE_KEY, key);
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
    required: ['reference_number', 'model', 'case_diameter_mm', 'serial_number', 'dial', 'bezel', 'material', 'diamonds', 'strap_type'],
    optional: ['movement', 'year', 'description'],
    conditionOptions: ['New', 'Unworn', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Papers', 'Warranty Card', 'Extra Links', 'Pouch'],
    notes: [
      'reference_number = the EXACT factory reference (Rolex 4-7 chars like "126610LN", "16610", "126710BLRO"; Patek "5711/1A-010"; AP "15500ST.OO.1220ST.01"; Omega "310.30.42.50.01.001"). NEVER return brand-name or family-name as reference. Read crown engraving / between-lugs / caseback if visible.',
      'model = full collector name including nickname when applicable (e.g. "Submariner Date \'Hulk\'", "GMT-Master II \'Pepsi\'", "Daytona \'Paul Newman\'", "Royal Oak Jumbo", "Nautilus 5711").',
      'case_diameter_mm = case width in millimetres (number only, e.g. 36, 40, 41, 42). Estimate from proportions vs crown/lugs if not stated. Common sizes: Submariner 40-41, Datejust 36/41, Daytona 40, GMT 40, Nautilus 40, Royal Oak 39-41, AP Offshore 42-44, Speedmaster 42. NEVER guess wider than 50.',
      'material ∈ {Steel, Gold, Rose Gold, White Gold, Two-Tone, Titanium, Plated}. strap_type ∈ {Leather, Rubber}. diamonds is boolean. movement = caliber if visible/known (e.g. "Cal. 3135", "Cal. 9461MC"). year = approximate production year (number).',
    ].join(' '),
  },
  'cat-gold-jewelry': {
    name: 'GOLD_JEWELRY',
    required: ['weight', 'karat', 'item_type', 'color_type'],
    optional: ['diamond_weight', 'description'],
    conditionOptions: ['New', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Certificate', 'Pouch'],
    notes: 'weight in grams (number). karat ∈ {24K, 22K, 21K, 18K, 14K, 9K}. item_type ∈ {Ring, Bangle, Bracelet, Necklace, Pendant, Earrings, Brooch}. color_type ∈ {Yellow Gold, Rose Gold, White Gold, Two-Tone}. diamond_weight in carats.',
  },
  'cat-branded-gold-jewelry': {
    name: 'BRANDED_GOLD_JEWELRY',
    required: ['item_type', 'color_type', 'size', 'karat'],
    optional: ['weight', 'diamond_weight', 'model_number', 'serial_number', 'certificate', 'box', 'description'],
    conditionOptions: ['New', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Certificate', 'Papers', 'Pouch', 'Receipt'],
    notes: 'karat ∈ {24K, 22K, 21K, 18K, 14K, 9K}. item_type ∈ {Ring, Bangle, Bracelet, Necklace, Pendant, Earrings, Brooch}. color_type ∈ {Yellow Gold, Rose Gold, White Gold, Two-Tone}. weight in grams (optional). certificate and box are booleans. size can be ring-size or "Small"/"Medium" etc.',
  },
  'cat-original-gold-jewelry': {
    name: 'ORIGINAL_GOLD_JEWELRY',
    required: ['item_type', 'color_type', 'size', 'karat'],
    optional: ['weight', 'diamond_weight', 'description'],
    conditionOptions: ['New', 'Pre-Owned', 'Vintage', 'Antique'],
    scopeOptions: ['Box', 'Certificate', 'Appraisal', 'Pouch'],
    notes: 'karat ∈ {24K, 22K, 21K, 18K, 14K, 9K}. item_type ∈ {Ring, Bangle, Bracelet, Necklace, Pendant, Earrings, Brooch}. color_type ∈ {Yellow Gold, Rose Gold, White Gold, Two-Tone}. weight in grams (optional). For antique/heritage include provenance in description.',
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
    required: ['model', 'part_type', 'material', 'original_or_copy', 'description'],
    optional: ['karat'],
    conditionOptions: ['New', 'Pre-Owned', 'Refurbished'],
    scopeOptions: ['Packaging'],
    notes: 'part_type ∈ {Dial, Bezel, Links, Crown, Strap, Buckle, Caseback, Movement, Crystal, Other}. original_or_copy ∈ {Original, Copy}. karat optional (only if gold part).',
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

**Rules**:
- Identify brand + exact model/reference/collection name — include nicknames where applicable (e.g. "Submariner 'Hulk'", "6062 'Dark Star'", "Cartier Love", "Bulgari Serpenti", "Van Cleef Alhambra")
- **WATCHES (CRITICAL — these three together identify the watch)**:
  1. **reference_number**: the EXACT manufacturer reference. Read it from the dial bottom, caseback engraving, between the lugs (Rolex), or papers if visible. NEVER substitute family-name (e.g. "Submariner") for a reference. Format examples by brand:
     - Rolex: 4-6 digits (vintage like "1601", "6062") or modern alphanumeric ("126610LN", "126710BLRO", "116500LN")
     - Patek Philippe: with slashes ("5711/1A-010", "5990/1A", "5167A-001")
     - Audemars Piguet: long codes ("15500ST.OO.1220ST.01", "26331ST.OO.1220ST.01")
     - Omega: dotted numerics ("310.30.42.50.01.001", "311.30.42.30.01.005")
     - Cartier: "WSSA0030", "W31044M7", "WGNM0017"
     - Vacheron / Lange / IWC / JLC: 4-7 digit numerics often with letters ("4500V/110A-B128", "IW371417", "Q1378420")
     - If you genuinely cannot read it, return null — do NOT fabricate.
  2. **model** (the exact collector name): include the family AND the nickname/variant (e.g. "Submariner Date 'Hulk'", "GMT-Master II 'Pepsi'", "Daytona 'Panda'", "Royal Oak Jumbo Extra-Thin", "Nautilus 5711/1A 'Tiffany'"). NEVER just "Submariner" — always specify the variant.
  3. **case_diameter_mm**: case width in mm. If the watch is identified, use the canonical factory size (Submariner 41 modern / 40 pre-2020, Datejust 36 or 41, Daytona 40, GMT 40, Nautilus 5711 = 40, Royal Oak Jumbo = 39, AP Offshore = 42, Speedmaster Pro = 42, Tank Solo medium = 31x27). Otherwise estimate from proportions (lugs/crown). Never default to "40" without basis.
  4. Plus: caliber/movement, year range, complications (chronograph, GMT, moonphase, day-date, perpetual calendar), dial color + indices, bezel material, strap type.
- For branded jewelry: maker, collection, variant, metal, stones
- For unbranded gold: weight (estimate from image), karat (estimate), craft style
- For accessories: maker, collection, leather/material, hardware, edition
- For spare parts: compatible model, generation, original vs aftermarket
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
  "attributes": { ${spec.required.map(k => `"${k}": null`).concat(spec.optional.map(k => `"${k}": null`)).join(', ')} }
}

Set fields to null/empty ONLY if truly indeterminable. Never guess serial numbers. For numeric fields (weight, karat numerical like "18K"→18, caseSize, year, price) return numbers, not strings. For booleans (diamonds, box, papers, certificate) return true/false. For selects return the exact string from the allowed options.`;

  const watchExtra = params.categoryId === 'cat-watch'
    ? '\n\nFor this WATCH, the three CRITICAL fields are reference_number (exact factory ref like "126610LN", not "Submariner"), model (full collector name including nickname like "Submariner Date \'Hulk\'"), and case_diameter_mm (numeric mm of the case). Look carefully at: dial bottom text, caseback engravings, between-lugs marking, crown engraving, papers/box if visible. If you cannot read the reference, infer it from dial config + bezel + case + hands combination. Never return a family name as the reference.'
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

  const response = await callOpenAI(
    [
      { role: 'system', content: systemPrompt },
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
