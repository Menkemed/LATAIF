// ═══════════════════════════════════════════════════════════
// LATAIF — Lightweight PDF Generator (Browser-only)
// Uses hidden iframe + print for PDF generation
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

interface PdfLine {
  label: string;
  value: string;
  bold?: boolean;
}

interface PdfSection {
  title?: string;
  lines: PdfLine[];
}

interface PdfOptions {
  title: string;
  subtitle?: string;
  number: string;
  date: string;
  customer?: { name: string; company?: string; phone?: string };
  sections: PdfSection[];
  footer?: string;
  type: 'offer' | 'invoice' | 'voucher' | 'receipt' | 'credit_note';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generatePdfHtml(opts: PdfOptions): string {
  const typeLabel = opts.type === 'offer' ? 'OFFER'
    : opts.type === 'invoice' ? 'INVOICE'
    : opts.type === 'voucher' ? 'REPAIR VOUCHER'
    : opts.type === 'credit_note' ? 'CREDIT NOTE'
    : 'PAYMENT RECEIPT';
  const accentColor = opts.type === 'credit_note' ? '#FF8730'
    : opts.type === 'voucher' || opts.type === 'receipt' ? '#0F0F10' : '#1a1a1a';

  let sectionsHtml = '';
  for (const section of opts.sections) {
    if (section.title) {
      sectionsHtml += `<div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.08em;margin:20px 0 8px;font-weight:600">${escapeHtml(section.title)}</div>`;
    }
    for (const line of section.lines) {
      const weight = line.bold ? 'font-weight:700;font-size:14px' : 'font-size:12px';
      // Mehrzeilige Labels: erste Zeile = Produkt-Name (fett), Rest = "Label: Value"-Specs
      // → kompaktes 2-Spalten-Mini-Grid statt vertikaler Liste.
      const parts = line.label.split('\n');
      let labelHtml: string;
      if (parts.length > 1) {
        const specCells = parts.slice(1).map(spec => {
          const colonIdx = spec.indexOf(':');
          if (colonIdx > 0) {
            const lbl = spec.slice(0, colonIdx).trim();
            const val = spec.slice(colonIdx + 1).trim();
            return `<div style="display:flex;gap:4px;line-height:1.35;break-inside:avoid"><span style="color:#999">${escapeHtml(lbl)}:</span><span style="color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(val)}</span></div>`;
          }
          return `<div style="line-height:1.35;color:#666">${escapeHtml(spec)}</div>`;
        }).join('');
        labelHtml = `<span style="display:block;max-width:65%"><strong>${escapeHtml(parts[0])}</strong>
          <div style="display:grid;grid-template-columns:1fr 1fr;column-gap:16px;row-gap:1px;margin-top:4px;font-size:10px;color:#444">${specCells}</div>
        </span>`;
      } else {
        labelHtml = `<span>${escapeHtml(line.label)}</span>`;
      }
      sectionsHtml += `<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-bottom:1px solid #eee;${weight}">
        ${labelHtml}
        <span style="font-family:monospace;white-space:nowrap;margin-left:12px">${escapeHtml(line.value === undefined || line.value === null ? '—' : String(line.value))}</span>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; padding: 40px; max-width: 800px; margin: 0 auto; }
  .header { text-align: center; border-bottom: 2px solid ${accentColor}; padding-bottom: 20px; margin-bottom: 24px; }
  .header .logo { width: 25%; max-width: 200px; height: auto; display: block; margin: 0 auto 8px; }
  .header .type { font-size: 11px; letter-spacing: 0.15em; color: #888; margin-top: 4px; text-transform: uppercase; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 24px; font-size: 12px; color: #555; }
  .meta-left, .meta-right { max-width: 48%; }
  .meta-right { text-align: right; }
  .meta div { margin-bottom: 3px; }
  .meta strong { color: #1a1a1a; }
  .content { margin-bottom: 24px; }
  .footer { text-align: center; margin-top: 40px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 10px; color: #999; }
  ${opts.type === 'voucher' ? '.voucher-code { text-align: center; font-size: 36px; font-family: monospace; font-weight: 700; letter-spacing: 0.15em; padding: 20px; margin: 20px 0; border: 2px dashed #0F0F10; color: #0F0F10; }' : ''}
  @media print { body { padding: 20px; } }
</style>
</head>
<body>
  <div class="header">
    <img class="logo" src="${logoDataUrl}" alt="Lataif Jewellery" />
    <div class="type">${typeLabel}</div>
  </div>
  <div class="meta">
    <div class="meta-left">
      ${opts.customer ? `<div><strong>${escapeHtml(opts.customer.name)}</strong></div>` : ''}
      ${opts.customer?.company ? `<div>${escapeHtml(opts.customer.company)}</div>` : ''}
      ${opts.customer?.phone ? `<div>${escapeHtml(opts.customer.phone)}</div>` : ''}
    </div>
    <div class="meta-right">
      <div><strong>${escapeHtml(opts.number)}</strong></div>
      <div>${escapeHtml(opts.date)}</div>
      ${opts.subtitle ? `<div>${escapeHtml(opts.subtitle)}</div>` : ''}
    </div>
  </div>
  <div class="content">${sectionsHtml}</div>
  ${opts.footer ? `<div class="footer">${escapeHtml(opts.footer)}</div>` : ''}
</body>
</html>`;
}

export function downloadPdf(opts: PdfOptions): void {
  const html = generatePdfHtml(opts);

  // Use hidden iframe for Tauri compatibility (window.open blocked)
  const existing = document.getElementById('lataif-pdf-frame');
  if (existing) existing.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'lataif-pdf-frame';
  iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:0;height:0;border:none;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) return;
  doc.open();
  doc.write(html);
  doc.close();

  setTimeout(() => {
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 2000);
  }, 300);
}
