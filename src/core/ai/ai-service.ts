// ═══════════════════════════════════════════════════════════
// LATAIF — AI Service (OpenAI)
// Product recognition, text generation, price suggestions
// ═══════════════════════════════════════════════════════════

import { buildSystemPrompt, buildUserPrompt, categorySpec, AI_MODEL_PARAMS } from './identify-prompt.ts';
import { getRuntimePaths } from '../runtime/runtime-paths';

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
    // DATA-ROOT-I1 — the key file lives in the data root, wherever that is. Resolved natively.
    const { openaiKey: path } = await getRuntimePaths();
    const { readTextFile, exists } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(path))) return '';
    const blob = await readTextFile(path);
    return deobfuscate(blob.trim());
  } catch { return ''; }
}

async function writeKeyToTauri(key: string): Promise<void> {
  try {
    const { dataRoot, openaiKey: path } = await getRuntimePaths();
    const { writeTextFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    if (!(await exists(dataRoot))) await mkdir(dataRoot, { recursive: true });
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
        const { openaiKey: path } = await getRuntimePaths();
        const { remove, exists } = await import('@tauri-apps/plugin-fs');
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

// MOBILE-I1B §1 — the category specs and the prompt now live in `identify-contract.json`, the ONE
// contract the embedded Rust server reads for `/api/ai/identify` as well. Extracted from the shipped
// v0.8.37 text character for character; `test/ai/identify-contract-parity.test.ts` rebuilds the
// prompt from commit ff038ad and fails if a single character differs, so the live-validated desktop
// behaviour cannot drift while the two surfaces share one source.

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
  const spec = categorySpec(params.categoryId);
  if (!spec) throw new Error(`Unknown category: ${params.categoryId}`);

  const hintsText = params.hints
    ? Object.entries(params.hints).filter(([, v]) => !!v).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';

  // MOBILE-I1B §1 — both prompts come from the shared contract. The watch-only suffix and the
  // hints/no-hints wording are part of that contract too, so the mobile route sends the identical
  // instruction rather than a lookalike written twice.
  const systemPrompt = buildSystemPrompt(params.categoryId);
  const userText = buildUserPrompt(params.categoryId, hintsText);

  const userContent: any[] = [{ type: 'text', text: userText }];
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
    AI_MODEL_PARAMS.maxTokens,
    AI_MODEL_PARAMS.temperature,
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

