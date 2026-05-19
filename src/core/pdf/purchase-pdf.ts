// ═══════════════════════════════════════════════════════════
// LATAIF — Purchase Print PDF (Browser/Tauri via hidden iframe + window.print)
// Druckt Ankaufs-Beleg mit Supplier-Block inkl. CPR + ID-Card-Bild,
// Item-Tabelle mit vollen Kategorie-Specs, Totals + Footer.
// ═══════════════════════════════════════════════════════════

import logoUrl from '@/assets/logo.png';
import type { Purchase, Supplier, Product, Category } from '@/core/models/types';
import { formatProductMultiLine } from '@/core/utils/product-format';

let logoDataUrl: string = logoUrl;
fetch(logoUrl)
  .then(r => r.blob())
  .then(blob => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  }))
  .then(dataUrl => { logoDataUrl = dataUrl; })
  .catch(() => { /* keep URL fallback */ });

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtBhd(v: number): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

export interface PurchasePdfOptions {
  purchase: Purchase;
  supplier?: Supplier;
  products: Product[];
  categories: Category[];
  branchName?: string;
}

function specsHtml(multiLine: string): string {
  const parts = multiLine.split('\n');
  if (parts.length <= 1) return '';
  const cells = parts.slice(1).map(spec => {
    const idx = spec.indexOf(':');
    if (idx > 0) {
      const lbl = escapeHtml(spec.slice(0, idx).trim());
      const val = escapeHtml(spec.slice(idx + 1).trim());
      return `<div style="display:flex;gap:4px;line-height:1.35;break-inside:avoid"><span style="color:#999">${lbl}:</span><span style="color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${val}</span></div>`;
    }
    return `<div style="line-height:1.35;color:#666">${escapeHtml(spec)}</div>`;
  }).join('');
  return `<div style="display:grid;grid-template-columns:1fr 1fr;column-gap:14px;row-gap:1px;margin-top:4px;font-size:10px;color:#444">${cells}</div>`;
}

export function generatePurchasePdfHtml(opts: PurchasePdfOptions): string {
  const { purchase, supplier, products, categories, branchName } = opts;

  // Audit: zuerst Snapshot lesen (eingefroren bei Create), erst dann Fallback
  // auf den live Supplier. Vermeidet rueckwirkende Aenderungen am Beleg wenn
  // der Supplier-Datensatz spaeter editiert wird.
  const snap = purchase.supplierSnapshot;
  const sName = snap?.name ?? supplier?.name ?? '—';
  const sPhone = snap?.phone ?? supplier?.phone;
  const sEmail = snap?.email ?? supplier?.email;
  const sAddress = snap?.address ?? supplier?.address;
  const sCpr = snap?.cpr ?? supplier?.cpr;
  const sCprImage = snap?.cprImage ?? supplier?.cprImage;

  const linesHtml = purchase.lines.map((l, i) => {
    const product = products.find(p => p.id === l.productId);
    const head = product ? `${product.brand || ''} ${product.name || ''}`.trim() : (l.description || '—');
    const multi = product ? formatProductMultiLine(product, categories) : '';
    const detail = specsHtml(multi);
    return `<tr style="border-bottom:1px solid #eee;page-break-inside:avoid">
      <td style="padding:10px 6px;font-size:11px;color:#888;vertical-align:top;width:28px">${i + 1}</td>
      <td style="padding:10px 6px;font-size:12px;color:#1a1a1a;vertical-align:top">
        <div style="font-weight:600">${escapeHtml(head)}</div>
        ${l.description ? `<div style="font-size:10px;color:#777;margin-top:2px">${escapeHtml(l.description)}</div>` : ''}
        ${detail}
      </td>
      <td style="padding:10px 6px;font-size:12px;color:#333;text-align:right;vertical-align:top;font-family:monospace">${l.quantity}</td>
      <td style="padding:10px 6px;font-size:12px;color:#333;text-align:right;vertical-align:top;font-family:monospace">${fmtBhd(l.unitPrice)}</td>
      <td style="padding:10px 6px;font-size:12px;color:#0F0F10;text-align:right;vertical-align:top;font-family:monospace;font-weight:600">${fmtBhd(l.lineTotal)}</td>
    </tr>`;
  }).join('');

  const paymentsHtml = purchase.payments.length === 0 ? '' : `
    <div style="margin-top:18px">
      <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">Payments</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        ${purchase.payments.map(p => `<tr style="border-bottom:1px solid #eee">
          <td style="padding:6px 4px;color:#333">${escapeHtml(p.paidAt)}</td>
          <td style="padding:6px 4px;color:#666;text-transform:uppercase;font-size:10px">${escapeHtml(p.method)}</td>
          <td style="padding:6px 4px;color:#666">${p.reference ? `Ref: ${escapeHtml(p.reference)}` : ''}</td>
          <td style="padding:6px 4px;color:#16A34A;text-align:right;font-family:monospace">${fmtBhd(p.amount)} BHD</td>
        </tr>`).join('')}
      </table>
    </div>
  `;

  // Supplier block: Name, optional company/phone/email/address + CPR + ID-Card-Image
  const supplierBlock = `
    <div style="border:1px solid #E5E9EE;border-radius:6px;padding:12px;background:#FAFAFA">
      <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px">Supplier / Seller</div>
      <div style="display:grid;grid-template-columns:1fr ${sCprImage ? '180px' : '0'};gap:16px;align-items:flex-start">
        <div>
          <div style="font-size:14px;color:#0F0F10;font-weight:600">${escapeHtml(sName)}</div>
          ${sPhone ? `<div style="font-size:11px;color:#555;margin-top:2px">Phone: ${escapeHtml(sPhone)}</div>` : ''}
          ${sEmail ? `<div style="font-size:11px;color:#555;margin-top:2px">Email: ${escapeHtml(sEmail)}</div>` : ''}
          ${sAddress ? `<div style="font-size:11px;color:#555;margin-top:2px">Address: ${escapeHtml(sAddress)}</div>` : ''}
          ${sCpr ? `<div style="font-size:12px;color:#0F0F10;margin-top:8px"><span style="color:#888;font-size:10px;letter-spacing:0.06em;text-transform:uppercase">CPR / ID:</span> <span style="font-family:monospace">${escapeHtml(sCpr)}</span></div>` : ''}
        </div>
        ${sCprImage ? `<div style="text-align:right">
          <div style="font-size:9px;color:#888;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:4px">ID Card</div>
          <img src="${sCprImage}" alt="CPR / ID Card" style="max-width:180px;max-height:120px;border:1px solid #ddd;border-radius:4px;object-fit:contain;background:#FFF" />
        </div>` : ''}
      </div>
    </div>
  `;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(purchase.purchaseNumber)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; padding: 36px; max-width: 820px; margin: 0 auto; }
  .header { text-align: center; border-bottom: 2px solid #1a1a1a; padding-bottom: 18px; margin-bottom: 18px; }
  .header .logo { width: 22%; max-width: 180px; height: auto; display: block; margin: 0 auto 6px; }
  .header .type { font-size: 11px; letter-spacing: 0.18em; color: #888; text-transform: uppercase; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 18px; font-size: 12px; color: #555; }
  .meta strong { color: #1a1a1a; }
  table.items { width: 100%; border-collapse: collapse; margin-top: 14px; }
  table.items th { text-align: left; font-size: 10px; color: #888; letter-spacing: 0.06em; text-transform: uppercase; padding: 8px 6px; border-bottom: 1px solid #ccc; }
  table.items th.num { text-align: right; }
  .totals { margin-top: 18px; margin-left: auto; width: 50%; }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 12px; color: #444; }
  .totals .row.grand { border-top: 2px solid #1a1a1a; margin-top: 6px; padding-top: 10px; font-size: 15px; font-weight: 700; color: #0F0F10; }
  .totals .row.outstanding { color: #DC2626; font-weight: 600; }
  .footer { text-align: center; margin-top: 32px; padding-top: 14px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }
  .sig-row { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 40px; }
  .sig-row .box { border-top: 1px solid #999; padding-top: 6px; font-size: 11px; color: #777; text-align: center; }
  @media print {
    body { padding: 18px; }
    table.items { page-break-inside: auto; }
    table.items tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="header">
    <img class="logo" src="${logoDataUrl}" alt="Lataif Jewellery" />
    <div class="type">Purchase / Ankaufsbeleg</div>
  </div>
  <div class="meta">
    <div>
      <div><strong>${escapeHtml(purchase.purchaseNumber)}</strong></div>
      <div>Status: ${escapeHtml(purchase.status)}</div>
    </div>
    <div style="text-align:right">
      <div><strong>${escapeHtml(fmtDate(purchase.purchaseDate))}</strong></div>
      ${branchName ? `<div>${escapeHtml(branchName)}</div>` : ''}
    </div>
  </div>

  ${supplierBlock}

  <table class="items">
    <thead>
      <tr>
        <th>#</th>
        <th>Item</th>
        <th class="num">Qty</th>
        <th class="num">Unit Price</th>
        <th class="num">Line Total</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Total</span><span style="font-family:monospace">${fmtBhd(purchase.totalAmount)} BHD</span></div>
    <div class="row" style="color:#16A34A"><span>Paid</span><span style="font-family:monospace">${fmtBhd(purchase.paidAmount)} BHD</span></div>
    <div class="row ${purchase.remainingAmount > 0 ? 'outstanding' : ''} grand">
      <span>${purchase.remainingAmount > 0 ? 'Outstanding (Payable)' : 'Settled'}</span>
      <span style="font-family:monospace">${fmtBhd(purchase.remainingAmount)} BHD</span>
    </div>
  </div>

  ${paymentsHtml}

  ${purchase.notes ? `<div style="margin-top:18px;font-size:11px;color:#555;border-top:1px solid #eee;padding-top:10px">
    <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:4px">Notes</div>
    ${escapeHtml(purchase.notes)}
  </div>` : ''}

  <div style="margin-top:30px;padding:10px 14px;background:#FAFAFA;border:1px solid #EEE;border-radius:6px;font-size:10px;color:#555;line-height:1.5">
    <strong style="color:#1a1a1a">Seller Declaration:</strong>
    The seller hereby declares lawful ownership of the items listed above, confirms the right to sell them, and consents to the processing of the personal data provided (CPR &amp; ID copy) for legal record-keeping and compliance with applicable regulations of the Kingdom of Bahrain.
  </div>

  <div class="sig-row">
    <div class="box">Supplier / Seller Signature</div>
    <div class="box">Authorised Signature</div>
  </div>

  <div class="footer">
    Generated ${escapeHtml(fmtDate(new Date().toISOString()))} · LATAIF Jewellery
    ${purchase.supplierSnapshot ? ' · Supplier data snapshot at ' + escapeHtml(fmtDate(purchase.supplierSnapshot.snapshotAt)) : ''}
  </div>
</body>
</html>`;
}

export function printPurchasePdf(opts: PurchasePdfOptions): void {
  const html = generatePurchasePdfHtml(opts);

  const existing = document.getElementById('lataif-purchase-pdf-frame');
  if (existing) existing.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'lataif-purchase-pdf-frame';
  iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:0;height:0;border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 350);
}
