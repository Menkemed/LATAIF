// ════════════════════════════════════════════════════════════════════════════
// INVOICE-A5 — die Rechnung zum Drucken, im Format A5 (Hochformat).
//
// Kopf mit Firmenname (Englisch/Arabisch), CR- und VAT-Nummer und Emblem; „TAX INVOICE";
// Kunde und Rechnungsangaben nebeneinander; die Positionen mit Menge, Preis, VAT % und VAT-Betrag;
// Betrag in Worten, Summen, Hinweis zum Margin-Schema, Bedingungen, Unterschriften, Fußzeile.
//
// Rein: Daten rein, HTML raus (ohne Datenbank, ohne Alias-Importe) — der Test prüft genau das,
// was gedruckt wird. Gedruckt wird wie überall über einen versteckten iframe (Tauri kennt kein
// window.open); „Als PDF speichern" bietet der Druckdialog.
//
// Steuer wie auf der bisherigen Kundenrechnung: beim Margin-Schema steht KEINE Steuer auf dem Beleg
// (0 %, Betrag inklusive), dafür der Hinweis „VAT has been imposed using the profit margin scheme";
// bei 10 % steht der Nettopreis, die Steuer und der Bruttobetrag.
// ════════════════════════════════════════════════════════════════════════════
import { formatGrams, productDisplayName } from '../products/display-name.ts';
import { caratThousandths, fmtCarat, stonesSummary } from '../products/stones.ts';

// ── Firma ──────────────────────────────────────────────────────────────────────────────────────
export interface InvoiceA5Company {
  nameEn: string; nameAr: string; crNumber: string; vatNumber: string;
  address: string; phone: string; email: string; instagram: string; terms: string;
}

/** Die Einstellungen, aus denen der Kopf kommt (Settings → Company Information). */
export const INVOICE_COMPANY_KEYS: Readonly<Record<keyof InvoiceA5Company, string>> = {
  nameEn: 'company.legal_name', nameAr: 'company.legal_name_ar', crNumber: 'company.cr_number', vatNumber: 'company.vat_number',
  address: 'company.address', phone: 'company.phone', email: 'company.email', instagram: 'company.instagram', terms: 'invoice.terms',
};

/** Was gilt, solange in den Einstellungen nichts steht. */
export const INVOICE_COMPANY_DEFAULTS: Readonly<InvoiceA5Company> = {
  nameEn: 'LATAIF JEWELLERY W.L.L.',
  nameAr: 'مجوهرات لطائف ذ.م.م',
  crNumber: '137216-1',
  vatNumber: '220015625500002',
  address: 'Shop 156, Building 203, Road 383, Block 304, Manama, Kingdom of Bahrain',
  phone: '+973 36211681',
  email: 'lataifwll@gmail.com',
  instagram: 'rahmatbahrain',
  terms: 'Goods remain our property until full payment is received. For any enquiry regarding this invoice, please contact us within 14 days.',
};

/** Je Feld: der Wert aus den Einstellungen, sonst die Vorgabe. */
export function invoiceCompany(read: (key: string) => string | null | undefined): InvoiceA5Company {
  const out = { ...INVOICE_COMPANY_DEFAULTS };
  for (const k of Object.keys(INVOICE_COMPANY_KEYS) as Array<keyof InvoiceA5Company>) {
    let v = '';
    try { v = String(read(INVOICE_COMPANY_KEYS[k]) ?? '').trim(); } catch { v = ''; }
    if (v) out[k] = v;
  }
  return out;
}

// ── Schreibweisen ──────────────────────────────────────────────────────────────────────────────
const MONATE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** „2026-08-31…" → „31-Aug-26" (der Kalendertag vor Ort). */
export function invoiceDateText(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim();
  if (!s) return '—';
  const d = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return String(d.getDate()).padStart(2, '0') + '-' + MONATE[d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
}

/** 16100 → „16,100.000" (drei Nachkommastellen wie überall in BHD). */
export function bhd(v: number): string {
  const n = Number.isFinite(v) ? v : 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

const EINER = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const ZEHNER = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function bisTausend(n: number): string {
  const teile: string[] = [];
  const h = Math.floor(n / 100), r = n % 100;
  if (h) teile.push(EINER[h] + ' Hundred');
  if (r) teile.push(r < 20 ? EINER[r] : ZEHNER[Math.floor(r / 10)] + (r % 10 ? ' ' + EINER[r % 10] : ''));
  return teile.join(' ');
}
function zahlInWorten(n: number): string {
  if (n === 0) return 'Zero';
  const stufen: Array<[number, string]> = [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand'], [1, '']];
  const teile: string[] = [];
  let rest = n;
  for (const [wert, name] of stufen) {
    const q = Math.floor(rest / wert);
    if (q) { teile.push(bisTausend(q) + (name ? ' ' + name : '')); rest -= q * wert; }
  }
  return teile.join(' ');
}
/** 16100 → „Bahrain Dinars Sixteen Thousand One Hundred Only"; 12.5 → „… Twelve and Five Hundred Fils Only". */
export function amountInWordsBhd(amount: number): string {
  const fils = Math.round(Math.abs(Number.isFinite(amount) ? amount : 0) * 1000);
  const dinare = Math.floor(fils / 1000), rest = fils % 1000;
  return 'Bahrain Dinars ' + zahlInWorten(dinare) + (rest ? ' and ' + zahlInWorten(rest) + ' Fils' : '') + ' Only';
}

const ZAHLWEG: Record<string, string> = {
  cash: 'Cash', card: 'Card', bank: 'Bank Transfer', bank_transfer: 'Bank Transfer', benefit: 'Benefit',
  credit: 'Store Credit', other: 'Other',
};
/** „Credit", solange nichts bezahlt ist; sonst die Zahlungswege — und „Credit" für einen offenen Rest. */
export function paymentModeText(methods: readonly string[], paid: number, balance: number): string {
  const wege: string[] = [];
  for (const m of methods) { const w = ZAHLWEG[m] ?? (m ? m.charAt(0).toUpperCase() + m.slice(1) : ''); if (w && !wege.includes(w)) wege.push(w); }
  if (!(paid > 0.0005)) return 'Credit';
  // Bezahlt, aber die Zahlungswege sind hier nicht bekannt (z. B. am zweiten Rechner): nichts erfinden.
  if (!wege.length) return balance > 0.0005 ? 'Partially Paid' : 'Paid';
  if (balance > 0.0005) wege.push('Credit');
  return wege.join(' / ');
}

// ── Daten des Belegs ───────────────────────────────────────────────────────────────────────────
export interface InvoiceA5Line { description: string; sku: string; details: string[]; qty: number; rate: number; vatPct: number; vatAmount: number; amount: number }
/** Die Bilder des Kopfes (Adressen oder Daten-URLs): Emblem in der Mitte, Schriftzug links Englisch, rechts Arabisch. */
export interface InvoiceA5Logos { emblem?: string; nameEn?: string; nameAr?: string }

export interface InvoiceA5Data {
  company: InvoiceA5Company;
  logos: InvoiceA5Logos;
  title: string;
  stamp: string;
  customer: Array<[string, string]>;
  invoice: Array<[string, string]>;
  lines: InvoiceA5Line[];
  subtotal: number; vatTotal: number; vatLabel: string; grandTotal: number;
  paid: number; balance: number;
  amountInWords: string;
  marginNotice: boolean;
}

/** Was der Beleg aus Rechnung, Kunde, Artikeln und Zahlungen braucht. */
export interface InvoiceA5Input {
  company: InvoiceA5Company;
  invoice: {
    number: string; status: string; issuedAt?: string | null; createdAt?: string | null;
    grossAmount: number; paidAmount: number;
    lines: Array<{ productId?: string; description?: string | null; quantity: number; taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number }>;
  };
  customer?: { firstName?: string; lastName?: string; company?: string; personalId?: string; phone?: string; vatAccountNumber?: string } | null;
  products: ReadonlyArray<{ id: string; brand?: string | null; name?: string | null; sku?: string | null; categoryId?: string | null; condition?: string | null; attributes?: Record<string, unknown> | string | null }>;
  paymentMethods: readonly string[];
  salesperson?: string;
  logos?: InvoiceA5Logos;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
function attrsOf(a: unknown): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === 'string') { try { const o = JSON.parse(a); return o && typeof o === 'object' ? o as Record<string, unknown> : {}; } catch { return {}; } }
  return typeof a === 'object' ? a as Record<string, unknown> : {};
}
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Uhren: nach Ref, Serial und SKU die Merkmale des Gehäuses — ohne Condition. */
const WATCH_DETAILS: readonly string[] = ['case_diameter_mm', 'dial', 'bezel', 'material', 'karat_color', 'strap_type'];
const merkmal = (v: unknown): string => (Array.isArray(v) ? v.map(text).filter(Boolean).join(', ') : text(v));

/** Gold-Kategorien: Karat, Gewicht und Diamanten gehören auf den Beleg. */
const GOLD_CATEGORIES: readonly string[] = ['cat-gold-jewelry', 'cat-branded-gold-jewelry', 'cat-original-gold-jewelry'];

/**
 * Die Kurzangaben unter dem Artikelnamen (die SKU steht klein neben dem Namen). Bezeichnung nur bei Ref, Serial
 * und Size; sonst nur der Wert; keine Condition. Uhren: Ref · Serial · Gehäuse … Schmuck: Art · Ref · Serial ·
 * Size · Karat · Gewicht · Diamanten — Art, Karat und Gewicht nur, wenn sie nicht schon im Namen stehen.
 */
export function lineDetails(p: InvoiceA5Input['products'][number] | undefined): string[] {
  if (!p) return [];
  const a = attrsOf(p.attributes);
  const out: string[] = [];
  const schmuck = GOLD_CATEGORIES.includes(String(p.categoryId ?? ''));
  const name = productDisplayName(p).toLowerCase();
  // Schmuck: zuerst die Art (Ring, Bangle, Bracelet …) — außer sie steht schon im Namen.
  const art = schmuck ? text(a.item_type) : '';
  if (art && art.toLowerCase() !== 'other' && !name.includes(art.toLowerCase())) out.push(art);
  const ref = text(a.reference_number) || text(a.model_number);
  if (ref) out.push('Ref: ' + ref);
  if (text(a.serial_number)) out.push('Serial: ' + text(a.serial_number));
  if (p.categoryId === 'cat-watch') {
    for (const key of WATCH_DETAILS) {
      const v = merkmal(a[key]);
      if (v) out.push(key === 'case_diameter_mm' && /^[0-9]+([.,][0-9]+)?$/.test(v) ? v + ' mm' : v);
    }
    return out;
  }
  if (text(a.size)) out.push('Size: ' + text(a.size));
  const steine = a.stones ? stonesSummary(a.stones) : '';
  if (schmuck) {
    const karat = text(a.karat);
    if (karat && !name.includes(karat.toLowerCase())) out.push(karat);
    const gramm = formatGrams(a.weight);
    if (gramm && !name.includes(gramm.toLowerCase())) out.push(gramm);
    // Diamanten: die Steinliste, sonst das einzelne Diamantgewicht (ältere Artikel).
    const dw = steine ? null : caratThousandths(a.diamond_weight);
    if (dw !== null && !Number.isNaN(dw) && dw > 0) out.push('Diamond ' + fmtCarat(dw) + ' ct');
  }
  if (steine) out.push(steine);
  return out;
}

export function buildInvoiceA5Data(input: InvoiceA5Input): InvoiceA5Data {
  const { invoice, customer } = input;
  const lines: InvoiceA5Line[] = invoice.lines.map((l) => {
    const p = input.products.find((x) => x.id === l.productId);
    const qty = Number(l.quantity) > 0 ? Number(l.quantity) : 1;
    const amount = r3(Number(l.lineTotal) || 0);
    // Nur die 10-%-Steuer steht auf dem Beleg; die Margin-Steuer bleibt im Betrag (wie bisher).
    const zeigtSteuer = l.taxScheme === 'VAT_10' && Number(l.vatAmount) > 0;
    const vatAmount = zeigtSteuer ? r3(Number(l.vatAmount)) : 0;
    const title = productDisplayName(p) || text(l.description) || '—';
    const details = lineDetails(p);
    if (text(l.description) && text(l.description) !== title) details.unshift(text(l.description));
    return { description: title, sku: text(p?.sku), details, qty, rate: r3((amount - vatAmount) / qty), vatPct: zeigtSteuer ? Number(l.vatRate) || 10 : 0, vatAmount, amount };
  });
  const grandTotal = r3(Number(invoice.grossAmount) || lines.reduce((s, l) => s + l.amount, 0));
  const vatTotal = r3(lines.reduce((s, l) => s + l.vatAmount, 0));
  const saetze = [...new Set(lines.filter((l) => l.vatAmount > 0).map((l) => l.vatPct))];
  const paid = r3(Math.max(0, Number(invoice.paidAmount) || 0));
  const balance = r3(Math.max(0, grandTotal - paid));

  const kunde: Array<[string, string]> = [];
  const name = [text(customer?.firstName), text(customer?.lastName)].filter(Boolean).join(' ');
  kunde.push(['Name', name || '—']);
  if (text(customer?.company)) kunde.push(['Company', text(customer?.company)]);
  if (text(customer?.personalId)) kunde.push(['ID/CR', text(customer?.personalId)]);
  if (text(customer?.phone)) kunde.push(['Mobile', text(customer?.phone)]);
  if (text(customer?.vatAccountNumber)) kunde.push(['TRN', text(customer?.vatAccountNumber)]);

  const beleg: Array<[string, string]> = [
    ['Invoice No.', invoice.number || '—'],
    ['Date', invoiceDateText(invoice.issuedAt || invoice.createdAt)],
    ['Payment Mode', paymentModeText(input.paymentMethods, paid, balance)],
    ['Salesperson', text(input.salesperson) || '—'],
  ];

  return {
    company: input.company,
    logos: input.logos ?? {},
    // FINAL (voll bezahlt) = Tax Invoice; PARTIAL (angezahlt) = Advance Payment Invoice; Entwurf = Proforma.
    title: invoice.status === 'PARTIAL' ? 'ADVANCE PAYMENT INVOICE' : invoice.status === 'DRAFT' ? 'PROFORMA INVOICE' : 'TAX INVOICE',
    stamp: invoice.status === 'CANCELLED' ? 'CANCELLED' : '',
    customer: kunde,
    invoice: beleg,
    lines,
    subtotal: r3(grandTotal - vatTotal),
    vatTotal,
    vatLabel: saetze.length === 1 ? `VAT Amount (${saetze[0]}%)` : saetze.length === 0 ? 'VAT Amount (0%)' : 'VAT Amount',
    grandTotal,
    paid,
    balance,
    amountInWords: amountInWordsBhd(grandTotal),
    marginNotice: invoice.lines.some((l) => l.taxScheme === 'MARGIN'),
  };
}

// ── HTML ───────────────────────────────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const GOLD = '#B8862E';

/** Das Emblem im Kopf: Kreis mit „L", oben LATAIF, unten JEWELLERY W.L.L., darüber ein Diamant. */
const EMBLEM = `<svg class="emblem" viewBox="0 0 120 126" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <path id="a5-top" d="M 25,74 A 35,35 0 0 1 95,74" />
    <path id="a5-bot" d="M 21,74 A 39,39 0 0 0 99,74" />
  </defs>
  <g fill="none" stroke="${GOLD}" stroke-linejoin="round">
    <path d="M 49,13 L 54,7 L 66,7 L 71,13 L 60,25 Z" stroke-width="1.2" />
    <path d="M 49,13 L 71,13 M 54,7 L 57,13 L 60,25 M 66,7 L 63,13 L 60,25 M 57,13 L 60,7 L 63,13" stroke-width="0.7" />
    <circle cx="60" cy="74" r="48" stroke-width="1.8" />
    <circle cx="60" cy="74" r="45" stroke-width="0.6" />
    <circle cx="60" cy="74" r="29" stroke-width="0.9" />
  </g>
  <text x="60" y="87" text-anchor="middle" fill="${GOLD}" font-family="'Brush Script MT','Segoe Script','Lucida Handwriting',cursive" font-size="36">L</text>
  <text fill="${GOLD}" font-family="Georgia,'Times New Roman',serif" font-size="10" font-weight="700" letter-spacing="2.5"><textPath href="#a5-top" startOffset="50%" text-anchor="middle">LATAIF</textPath></text>
  <text fill="${GOLD}" font-family="Georgia,'Times New Roman',serif" font-size="6.4" font-weight="700" letter-spacing="0.8"><textPath href="#a5-bot" startOffset="50%" text-anchor="middle">JEWELLERY W.L.L.</textPath></text>
</svg>`;

const ICON_PIN = `<svg viewBox="0 0 24 24" class="ico"><path fill="${GOLD}" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2z"/></svg>`;
const ICON_TEL = `<svg viewBox="0 0 24 24" class="ico"><path fill="${GOLD}" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>`;
const ICON_INSTA = `<svg viewBox="0 0 24 24" class="ico"><rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="${GOLD}" stroke-width="1.8"/><circle cx="12" cy="12" r="4" fill="none" stroke="${GOLD}" stroke-width="1.8"/><circle cx="17.2" cy="6.8" r="1.2" fill="${GOLD}"/></svg>`;
const ICON_MAIL = `<svg viewBox="0 0 24 24" class="ico"><rect x="3" y="5.5" width="18" height="13" rx="1.5" fill="none" stroke="${GOLD}" stroke-width="1.8"/><path d="M3.5 6.5 12 13l8.5-6.5" fill="none" stroke="${GOLD}" stroke-width="1.8"/></svg>`;

/** Der Firmenname mit kleiner gesetzter Rechtsform („LATAIF JEWELLERY" + „W.L.L."). */
function nameMitRechtsform(name: string): string {
  const m = /^(.*?)\s+(W\.?L\.?L\.?|B\.?S\.?C\.?(?:\s*\(c\))?|S\.?P\.?C\.?|LLC|Ltd\.?)$/i.exec(name.trim());
  return m ? `${esc(m[1])} <small>${esc(m[2])}</small>` : esc(name);
}

function kvRows(rows: Array<[string, string]>): string {
  return rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="colon">:</td><td>${esc(v)}</td></tr>`).join('');
}

export function invoiceA5Html(d: InvoiceA5Data): string {
  const c = d.company;
  const rows = d.lines.map((l, i) => `<tr>
      <td class="c-no">${i + 1}</td>
      <td class="c-desc"><div class="d-title">${esc(l.description)}${l.sku ? ` <span class="d-sku">SKU: ${esc(l.sku)}</span>` : ''}</div>${l.details.length ? `<div class="d-sub">${l.details.map((x) => `<span class="d-it">${esc(x)}</span>`).join('&nbsp;<span class="dot">·</span> ')}</div>` : ''}</td>
      <td class="c-qty">${l.qty} pcs</td>
      <td class="num">${bhd(l.rate)}</td>
      <td class="c-vat">${l.vatPct} %</td>
      <td class="num">${bhd(l.vatAmount)}</td>
      <td class="num">${bhd(l.amount)}</td>
    </tr>`).join('');
  const bezahlt = d.paid > 0.0005
    ? `<tr><td>Paid</td><td class="cur">BHD</td><td class="num">${bhd(d.paid)}</td></tr><tr><td>Balance Due</td><td class="cur">BHD</td><td class="num">${bhd(d.balance)}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(d.title)} ${esc((d.invoice[0] || ['', ''])[1])}</title>
<style>
  @page { size: A5 portrait; margin: 8mm 8mm 9mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2328; font-size: 7.4pt; line-height: 1.35;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .doc { width: 132mm; min-height: 190mm; margin: 0 auto; display: flex; flex-direction: column; position: relative; }
  .gold { color: ${GOLD}; }
  .head { display: grid; grid-template-columns: 1fr 22mm 1fr; align-items: center; column-gap: 3mm; padding-bottom: 1.6mm; border-bottom: 0.5pt solid ${GOLD}; }
  .co-en .name { font-family: Georgia, 'Times New Roman', serif; font-weight: 700; font-size: 11.2pt; color: ${GOLD}; letter-spacing: 0.1pt; white-space: nowrap; }
  .co-en .name small { font-size: 7.4pt; letter-spacing: 0; }
  .co-ar { text-align: right; }
  .co-ar .name { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-weight: 700; font-size: 13pt; color: ${GOLD}; white-space: nowrap; }
  .ids { font-size: 6.2pt; color: #333; margin-top: 1mm; white-space: nowrap; }
  .ids b { font-weight: 700; color: #1f2328; }
  .emblem { width: 18mm; height: 19mm; display: block; }
  .emblem-img { width: 19mm; height: auto; display: block; justify-self: center; }
  .name-img { display: block; height: auto; }
  /* Beide Schriftzüge füllen ihre Spalte: gleicher Abstand zum Emblem links und rechts (Seitenverhältnis bleibt). */
  .co-en .name-img, .co-ar .name-img { width: 100%; }
  /* Gleich hohe Felder für beide Schriftzüge (mittig): die CR/VAT-Zeile steht links und rechts auf derselben Höhe. */
  .name-box { height: 8.4mm; display: flex; align-items: center; }
  .title { display: flex; align-items: center; justify-content: center; gap: 4mm; margin: 1.6mm 0 1.6mm; }
  .title .line { flex: 0 0 18mm; border-top: 0.5pt solid ${GOLD}; }
  .title h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 13.5pt; letter-spacing: 1pt; color: #1b2433; font-weight: 700; }
  .stamp { position: absolute; top: 38mm; right: 4mm; transform: rotate(-12deg); border: 1.2pt solid #B42318; color: #B42318; font-weight: 800; font-size: 11pt; letter-spacing: 2pt; padding: 1mm 3mm; border-radius: 1.5mm; opacity: 0.85; }
  .parties { display: grid; grid-template-columns: 1fr 0.5pt 0.92fr; column-gap: 4mm; margin-bottom: 2.4mm; }
  .parties .divider { background: ${GOLD}; }
  .parties h2 { font-size: 8pt; font-weight: 700; margin-bottom: 0.8mm; }
  .kv { border-collapse: collapse; }
  .kv th { text-align: left; font-weight: 400; color: #333; white-space: nowrap; padding: 0.15mm 0; vertical-align: top; }
  .kv td { padding: 0.15mm 0; vertical-align: top; }
  .kv td.colon { padding: 0.15mm 1.8mm; color: #333; }
  table.items { width: 100%; border-collapse: collapse; table-layout: fixed; }
  table.items thead { display: table-header-group; }
  table.items th { background: #F8F0E1; font-weight: 700; font-size: 6.8pt; line-height: 1.2; padding: 1.2mm 1mm; text-align: center; vertical-align: top;
    border-top: 0.6pt solid ${GOLD}; border-bottom: 0.4pt solid #E6D6B8; }
  table.items th span { display: block; font-weight: 400; color: #444; }
  table.items th.h-desc { text-align: left; vertical-align: middle; }
  table.items th.h-no { vertical-align: middle; }
  table.items td { padding: 0.9mm 1mm; border-bottom: 0.4pt solid #E9E2D4; vertical-align: middle; }
  table.items tr { break-inside: avoid; page-break-inside: avoid; }
  table.items td + td, table.items th + th { border-left: 0.4pt solid #EFE6D6; }
  .c-no { text-align: center; }
  .c-qty, .c-vat { text-align: center; white-space: nowrap; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .d-title { font-weight: 600; font-size: 7.4pt; }
  /* Die SKU klein neben dem Namen, wie die Angaben darunter. */
  .d-sku { font-weight: 400; font-style: italic; font-size: 6pt; color: #444; margin-left: 1.2mm; white-space: nowrap; }
  .d-sub { font-style: italic; font-size: 6pt; color: #444; margin-top: 0.2mm; line-height: 1.22; }
  /* Eine Angabe bricht nie in sich um („Case Diameter: 36 mm" bleibt beisammen) — nur zwischen den Angaben. */
  .d-sub .d-it { white-space: nowrap; }
  .d-sub .dot { padding: 0 0.3mm; font-style: normal; }
  .sum { display: grid; grid-template-columns: 1fr 58mm; column-gap: 4mm; align-items: center; margin-top: 2mm; break-inside: avoid; }
  .words b { font-weight: 700; margin-right: 1mm; }
  table.totals { width: 100%; border-collapse: collapse; }
  table.totals td { padding: 0.55mm 1.4mm; border-bottom: 0.4pt solid #EFE6D6; }
  table.totals td:first-child { font-weight: 600; }
  table.totals .cur { color: #444; width: 9mm; }
  table.totals .num { font-weight: 700; font-size: 8pt; }
  table.totals tr.grand td { background: #F3E7CF; font-size: 9pt; font-weight: 700; padding: 1mm 1.4mm; border-bottom: none; }
  table.totals tr.grand .num { font-size: 9.6pt; }
  .notice { margin-top: 2mm; border-top: 0.5pt solid ${GOLD}; border-bottom: 0.5pt solid ${GOLD}; text-align: center; padding: 0.8mm 0; font-size: 6.8pt; letter-spacing: 0.2pt; }
  .terms { padding: 1mm 0 1mm; border-bottom: 0.5pt solid ${GOLD}; font-size: 6.4pt; }
  .terms .bullet { color: ${GOLD}; font-size: 8pt; margin: 0 1.4mm 0 0.6mm; }
  .terms b { font-weight: 700; }
  .spacer { flex: 1 1 auto; min-height: 2mm; }
  .sign { display: flex; justify-content: space-between; align-items: flex-start; gap: 8mm; break-inside: avoid; }
  .sign div { width: 48mm; font-size: 7.6pt; text-align: center; }
  .sign .sl { display: block; border-bottom: 0.6pt solid #1f2328; height: 5.5mm; margin-bottom: 0.8mm; }
  /* Fußzeile in EINER Zeile: Adresse · Telefon · E-Mail · Instagram. Nur eine längere Adresse darf umbrechen. */
  .foot { margin-top: 2mm; border-top: 0.6pt solid ${GOLD}; padding-top: 1.8mm; display: flex; align-items: center; justify-content: space-between; gap: 1.5mm; font-size: 5.2pt; break-inside: avoid; }
  .foot .it { display: flex; align-items: center; gap: 1mm; white-space: nowrap; }
  .foot .it.addr { white-space: normal; min-width: 0; }
  .foot .sep { width: 0.5pt; height: 3mm; background: ${GOLD}; flex: 0 0 auto; }
  .ico { width: 2.6mm; height: 2.6mm; flex: 0 0 auto; }
  @media screen { body { background: #eee; padding: 10mm 0; } .doc { background: #fff; padding: 8mm; width: 148mm; min-height: 210mm; box-shadow: 0 1px 6px rgba(0,0,0,.15); } }
</style></head>
<body><div class="doc">
  <header class="head">
    <div class="co-en">
      ${d.logos.nameEn ? `<div class="name-box"><img class="name-img" src="${esc(d.logos.nameEn)}" alt="${esc(c.nameEn)}" /></div>` : `<div class="name">${nameMitRechtsform(c.nameEn)}</div>`}
      <div class="ids"><b>CR No.:</b> ${esc(c.crNumber)} &nbsp;|&nbsp; <b>VAT No.:</b> ${esc(c.vatNumber)}</div>
    </div>
    ${d.logos.emblem ? `<img class="emblem-img" src="${esc(d.logos.emblem)}" alt="" />` : EMBLEM}
    <div class="co-ar" dir="rtl" lang="ar">
      ${d.logos.nameAr ? `<div class="name-box"><img class="name-img" src="${esc(d.logos.nameAr)}" alt="${esc(c.nameAr)}" /></div>` : `<div class="name">${esc(c.nameAr)}</div>`}
      <div class="ids"><b>س.ت:</b> <bdi dir="ltr">${esc(c.crNumber)}</bdi> &nbsp;|&nbsp; <b>الرقم الضريبي:</b> <bdi dir="ltr">${esc(c.vatNumber)}</bdi></div>
    </div>
  </header>
  <div class="title"><span class="line"></span><h1>${esc(d.title)}</h1><span class="line"></span></div>
  ${d.stamp ? `<div class="stamp">${esc(d.stamp)}</div>` : ''}
  <section class="parties">
    <div><h2>Customer Details</h2><table class="kv">${kvRows(d.customer)}</table></div>
    <div class="divider"></div>
    <div><h2>Invoice Details</h2><table class="kv">${kvRows(d.invoice)}</table></div>
  </section>
  <table class="items">
    <colgroup><col style="width:4.5%"><col style="width:47%"><col style="width:7%"><col style="width:12%"><col style="width:6%"><col style="width:11%"><col style="width:12.5%"></colgroup>
    <thead><tr>
      <th class="h-no">#</th><th class="h-desc">Item Description</th><th>Qty</th><th>Rate<span>(BHD)</span></th><th>VAT<span>%</span></th><th>VAT Amount<span>(BHD)</span></th><th>Amount<span>(BHD)</span></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <section class="sum">
    <div class="words"><b>Amount in Words :</b> ${esc(d.amountInWords)}.</div>
    <table class="totals">
      <tr><td>Subtotal</td><td class="cur">BHD</td><td class="num">${bhd(d.subtotal)}</td></tr>
      <tr><td>${esc(d.vatLabel)}</td><td class="cur">BHD</td><td class="num">${bhd(d.vatTotal)}</td></tr>
      <tr class="grand"><td>Grand Total</td><td class="cur">BHD</td><td class="num">${bhd(d.grandTotal)}</td></tr>
      ${bezahlt}
    </table>
  </section>
  ${d.marginNotice ? '<div class="notice">VAT HAS BEEN IMPOSED USING THE PROFIT MARGIN SCHEME</div>' : ''}
  <div class="terms"${d.marginNotice ? '' : ' style="border-top:0.5pt solid ' + GOLD + ';margin-top:2mm"'}><span class="bullet">●</span><b>Terms &amp; Conditions:</b> ${esc(c.terms)}</div>
  <div class="spacer"></div>
  <section class="sign">
    <div><span class="sl"></span>Customer’s Signature</div>
    <div><span class="sl"></span>Authorised Signatory</div>
  </section>
  <footer class="foot">
    <div class="it addr">${ICON_PIN}<span>${esc(c.address)}</span></div>
    <div class="sep"></div>
    <div class="it">${ICON_TEL}<span>${esc(c.phone)}</span></div>
    <div class="sep"></div>
    <div class="it">${ICON_MAIL}<span>${esc(c.email)}</span></div>
    ${c.instagram ? `<div class="sep"></div>
    <div class="it">${ICON_INSTA}<span>@${esc(c.instagram.replace(/^@+/, ''))}</span></div>` : ''}
  </footer>
</div></body></html>`;
}

/** Den Beleg drucken (Druckdialog, dort auch „Als PDF speichern"). */
export function printInvoiceA5(d: InvoiceA5Data): void {
  const alt = document.getElementById('lataif-invoice-a5');
  if (alt) alt.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'lataif-invoice-a5';
  iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:0;height:0;border:none;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(invoiceA5Html(d));
  doc.close();
  // Erst drucken, wenn Emblem und Schriftzüge geladen sind (höchstens 3 s warten).
  const bilder = Array.from(doc.images).map((img) => (img.complete ? Promise.resolve() : new Promise<void>((r) => { img.onload = () => r(); img.onerror = () => r(); })));
  const bereit = Promise.race([Promise.all(bilder), new Promise((r) => setTimeout(r, 3000))]);
  void bereit.then(() => setTimeout(() => {
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 150));
}
