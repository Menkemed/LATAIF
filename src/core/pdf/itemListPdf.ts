// ═══════════════════════════════════════════════════════════
// LATAIF — Print/PDF Item-List Generator (2026-05-18)
//
// Tabellarisches Listen-Dokument fuer Approval (Agent) und Consignment.
// Spiegelt das iframe-Print-Muster aus pdf-generator.ts wider, aber mit
// <table>-Layout statt Key-Value-Sections. Ein Document kann mehrere
// "Groups" enthalten (pro Agent/Consignor eine) — fuer Per-Person- und
// Aggregat-Aussichten geteilt.
// ═══════════════════════════════════════════════════════════

import logoUrl from '@/assets/logo.png';

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

export type ItemListFilter = 'all' | 'sold' | 'open' | 'returned';

export interface ItemListRow {
  date: string;
  itemLabel: string;              // "Brand Name"
  /** Volle Kategorie-Attribute (z.B. "Steel · 40mm · Black Dial · Pre-Owned")
   *  als Eine-Zeile-Untertitel unter dem itemLabel. Wird gerendert als
   *  kleinere graue Zeile direkt darunter. */
  specsLine?: string;
  refOrSerial?: string;           // SKU / Reference / Serial — kompakt in einer Zelle
  ourPrice: number;               // Approval: agentPrice / Consignment: agreedPrice
  saleOrPayout?: number;          // Approval: actualSalePrice / Consignment: salePrice
  paid?: number;                  // Approval only
  outstanding?: number;           // Approval only
  payout?: number;                // Consignment only — payoutAmount
  returnDate?: string;            // Approval only
  status: string;                 // human-readable
}

export interface ItemListGroup {
  heading: string;                // "Ahmed Al-Mansour" oder "John Doe — Acme Co."
  contact?: string;               // Phone / Email Untertitel
  rows: ItemListRow[];
  summary?: string;               // "5 items · Outstanding 1,200.000 BHD"
}

export interface ItemListPdfOptions {
  kind: 'approval' | 'consignment';
  filter: ItemListFilter;
  branchName?: string;
  groups: ItemListGroup[];
  /** Wenn true → Dokument-Titel zeigt "All Approvals/Consignors". */
  isAggregate?: boolean;
}

function escapeHtml(text: string | number | null | undefined): string {
  if (text === null || text === undefined) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtBhd(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function filterLabel(f: ItemListFilter): string {
  if (f === 'all') return 'All Items';
  if (f === 'sold') return 'Sold Items';
  if (f === 'open') return 'Open / Not Sold Items';
  return 'Returned Items';
}

function renderApprovalTable(rows: ItemListRow[]): string {
  if (rows.length === 0) {
    return `<p style="font-size:11px;color:#888;font-style:italic;padding:8px 0">No items match the selected filter.</p>`;
  }
  const cellBase = 'padding:6px 8px;font-size:11px;border-bottom:1px solid #eee;vertical-align:top';
  const head = 'padding:6px 8px;font-size:9px;color:#888;letter-spacing:0.06em;text-transform:uppercase;text-align:left;border-bottom:1px solid #ccc;background:#fafafa';
  const headerCols = ['#', 'Date', 'Item', 'Ref / Serial', 'Our Price', 'Status', 'Paid', 'Outstanding', 'Return By'];
  let html = `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-family:'Helvetica Neue',Arial,sans-serif">`;
  html += `<thead><tr>${headerCols.map(h => `<th style="${head}${(h==='Our Price'||h==='Paid'||h==='Outstanding')?';text-align:right':''}">${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  html += `<tbody>`;
  rows.forEach((r, i) => {
    const itemCell = `<div style="color:#1a1a1a">${escapeHtml(r.itemLabel || '—')}</div>${r.specsLine ? `<div style="color:#888;font-size:10px;margin-top:2px;line-height:1.3">${escapeHtml(r.specsLine)}</div>` : ''}`;
    html += `<tr>
      <td style="${cellBase};color:#999;width:24px">${i + 1}</td>
      <td style="${cellBase};color:#555;white-space:nowrap">${escapeHtml(r.date || '—')}</td>
      <td style="${cellBase}">${itemCell}</td>
      <td style="${cellBase};color:#555;font-family:monospace;font-size:10px">${escapeHtml(r.refOrSerial || '—')}</td>
      <td style="${cellBase};color:#1a1a1a;font-family:monospace;text-align:right;white-space:nowrap">${fmtBhd(r.ourPrice)}</td>
      <td style="${cellBase};color:#1a1a1a">${escapeHtml(r.status || '—')}</td>
      <td style="${cellBase};color:${(r.paid || 0) > 0 ? '#5C8550' : '#999'};font-family:monospace;text-align:right;white-space:nowrap">${fmtBhd(r.paid)}</td>
      <td style="${cellBase};color:${(r.outstanding || 0) > 0 ? '#AA6E6E' : '#999'};font-family:monospace;text-align:right;white-space:nowrap">${fmtBhd(r.outstanding)}</td>
      <td style="${cellBase};color:#555;white-space:nowrap">${escapeHtml(r.returnDate || '—')}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

function renderConsignmentTable(rows: ItemListRow[]): string {
  if (rows.length === 0) {
    return `<p style="font-size:11px;color:#888;font-style:italic;padding:8px 0">No items match the selected filter.</p>`;
  }
  const cellBase = 'padding:6px 8px;font-size:11px;border-bottom:1px solid #eee;vertical-align:top';
  const head = 'padding:6px 8px;font-size:9px;color:#888;letter-spacing:0.06em;text-transform:uppercase;text-align:left;border-bottom:1px solid #ccc;background:#fafafa';
  const headerCols = ['#', 'Date', 'Item', 'Ref / Serial', 'Agreed Price', 'Sale Price', 'Payout', 'Status'];
  let html = `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-family:'Helvetica Neue',Arial,sans-serif">`;
  html += `<thead><tr>${headerCols.map(h => `<th style="${head}${(h==='Agreed Price'||h==='Sale Price'||h==='Payout')?';text-align:right':''}">${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  html += `<tbody>`;
  rows.forEach((r, i) => {
    const itemCell = `<div style="color:#1a1a1a">${escapeHtml(r.itemLabel || '—')}</div>${r.specsLine ? `<div style="color:#888;font-size:10px;margin-top:2px;line-height:1.3">${escapeHtml(r.specsLine)}</div>` : ''}`;
    html += `<tr>
      <td style="${cellBase};color:#999;width:24px">${i + 1}</td>
      <td style="${cellBase};color:#555;white-space:nowrap">${escapeHtml(r.date || '—')}</td>
      <td style="${cellBase}">${itemCell}</td>
      <td style="${cellBase};color:#555;font-family:monospace;font-size:10px">${escapeHtml(r.refOrSerial || '—')}</td>
      <td style="${cellBase};color:#1a1a1a;font-family:monospace;text-align:right;white-space:nowrap">${fmtBhd(r.ourPrice)}</td>
      <td style="${cellBase};color:${(r.saleOrPayout ?? 0) > 0 ? '#1a1a1a' : '#999'};font-family:monospace;text-align:right;white-space:nowrap">${r.saleOrPayout != null ? fmtBhd(r.saleOrPayout) : '—'}</td>
      <td style="${cellBase};color:${(r.payout ?? 0) > 0 ? '#5C8550' : '#999'};font-family:monospace;text-align:right;white-space:nowrap">${r.payout != null ? fmtBhd(r.payout) : '—'}</td>
      <td style="${cellBase};color:#1a1a1a">${escapeHtml(r.status || '—')}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  return html;
}

export function generateItemListHtml(opts: ItemListPdfOptions): string {
  const docTitle = opts.kind === 'approval' ? 'APPROVAL ITEM LISTING' : 'CONSIGNMENT ITEM LISTING';
  const today = new Date().toISOString().slice(0, 10);
  const scopeLabel = opts.isAggregate
    ? (opts.kind === 'approval' ? 'All Approvals' : 'All Consignors')
    : (opts.groups[0]?.heading || '');

  let groupsHtml = '';
  if (opts.groups.length === 0) {
    groupsHtml = `<p style="font-size:12px;color:#888;text-align:center;padding:40px 0;font-style:italic">No matching items.</p>`;
  } else {
    for (const g of opts.groups) {
      groupsHtml += `<div style="margin-bottom:24px;page-break-inside:avoid">
        <div style="border-bottom:1px solid #ddd;padding-bottom:6px;margin-bottom:6px">
          <div style="font-size:14px;font-weight:600;color:#1a1a1a">${escapeHtml(g.heading)}</div>
          ${g.contact ? `<div style="font-size:10px;color:#777;margin-top:2px">${escapeHtml(g.contact)}</div>` : ''}
        </div>
        ${opts.kind === 'approval' ? renderApprovalTable(g.rows) : renderConsignmentTable(g.rows)}
        ${g.summary ? `<div style="font-size:10px;color:#666;margin-top:6px;padding-top:6px;border-top:1px dashed #ddd;text-align:right">${escapeHtml(g.summary)}</div>` : ''}
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; padding: 32px 40px; max-width: 980px; margin: 0 auto; }
  .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #1a1a1a; padding-bottom: 14px; margin-bottom: 18px; }
  .header-left { display: flex; align-items: center; gap: 14px; }
  .header img.logo { width: 70px; height: auto; }
  .title-block .doc-type { font-size: 11px; letter-spacing: 0.15em; color: #888; text-transform: uppercase; margin-bottom: 2px; }
  .title-block .scope { font-size: 18px; color: #1a1a1a; font-weight: 600; }
  .title-block .filter { font-size: 11px; color: #5C8550; margin-top: 2px; letter-spacing: 0.04em; }
  .header-right { text-align: right; font-size: 11px; color: #555; }
  .header-right .branch { color: #1a1a1a; font-weight: 500; margin-bottom: 2px; }
  .footer { text-align: center; margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 9px; color: #999; }
  @media print {
    body { padding: 16px 24px; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    .header { page-break-after: avoid; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <img class="logo" src="${logoDataUrl}" alt="LATAIF" />
      <div class="title-block">
        <div class="doc-type">${escapeHtml(docTitle)}</div>
        <div class="scope">${escapeHtml(scopeLabel || '—')}</div>
        <div class="filter">Filter: ${escapeHtml(filterLabel(opts.filter))}</div>
      </div>
    </div>
    <div class="header-right">
      ${opts.branchName ? `<div class="branch">${escapeHtml(opts.branchName)}</div>` : ''}
      <div>${escapeHtml(today)}</div>
    </div>
  </div>
  ${groupsHtml}
  <div class="footer">Generated ${escapeHtml(today)} · LATAIF Jewellery</div>
</body>
</html>`;
}

export function printItemListPdf(opts: ItemListPdfOptions): void {
  try {
    const html = generateItemListHtml(opts);

    // Versteckter iframe + window.print() — identisches Pattern wie downloadPdf().
    // In Tauri oeffnet das den OS-Print-Dialog (inkl. "Save as PDF"), im Browser
    // den Browser-Print-Dialog.
    const existing = document.getElementById('lataif-itemlist-frame');
    if (existing) existing.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'lataif-itemlist-frame';
    iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:0;height:0;border:none;';
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) {
      console.error('[itemListPdf] iframe contentDocument unavailable');
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();

    // Focus + print: bei Tauri/WebView2 ist iframe.contentWindow.focus()
    // noetig damit der Print-Dialog die iframe-Inhalte druckt und nicht
    // die App-Outerframe. Identisch zu downloadPdf-Pattern.
    setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch (err) {
        console.error('[itemListPdf] print failed:', err);
      }
      setTimeout(() => iframe.remove(), 2000);
    }, 300);
  } catch (err) {
    console.error('[itemListPdf] fatal:', err);
    alert(`Print failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
