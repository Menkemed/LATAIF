// Cross-environment file export (Tauri + Browser).
// In Tauri: nativer Save-Dialog + fs-write. In Browser: Blob-URL + a.click().

type Content = string | Uint8Array;

function isTauri(): boolean {
  if (typeof window === 'undefined') return false;
  // Tauri 2 nutzt __TAURI_INTERNALS__; ältere Builds haben __TAURI__.
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

async function saveViaTauri(filename: string, content: Content, mimeType: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const { downloadDir, join } = await import('@tauri-apps/api/path');

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const filterName = mimeType.includes('excel') ? 'Excel'
    : mimeType.includes('csv') ? 'CSV'
    : mimeType.includes('pdf') ? 'PDF'
    : mimeType.includes('json') ? 'JSON'
    : 'File';

  const defaultDir = await downloadDir().catch(() => null);
  const defaultPath = defaultDir ? await join(defaultDir, filename) : filename;

  const chosen = await save({
    defaultPath,
    filters: ext ? [{ name: filterName, extensions: [ext] }] : undefined,
  });
  if (!chosen) return true; // User cancelled — nicht fallbacken

  // Immer als Bytes schreiben — vermeidet getrennte Text/Binary-ACL-Probleme.
  const bytes = typeof content === 'string'
    ? new TextEncoder().encode(content)
    : content;
  await writeFile(chosen as string, bytes);
  return true;
}

function saveViaBrowser(filename: string, content: Content, mimeType: string): void {
  // Cast to BlobPart for TS; both string und Uint8Array sind zur Laufzeit valide BlobParts.
  const blob = new Blob([content as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

export async function exportFile(filename: string, content: Content, mimeType: string): Promise<void> {
  if (isTauri()) {
    try {
      const ok = await saveViaTauri(filename, content, mimeType);
      if (ok) return;
    } catch (e) {
      // Fehler sichtbar machen — nicht stumm in den Browser-Fallback (der in WebView nichts tut).
      const msg = (e as Error)?.message || String(e);
      alert(`Export failed:\n${msg}\n\nFile: ${filename}`);
      console.error('[export] Tauri save failed:', e);
      return;
    }
  }
  saveViaBrowser(filename, content, mimeType);
}

// Helper: CSV-String mit BOM für Excel-Kompatibilität
export async function exportCsv(filename: string, text: string): Promise<void> {
  return exportFile(filename, '\uFEFF' + text, 'text/csv;charset=utf-8');
}

// Helper: Excel (HTML-Tabelle als .xls)
export async function exportExcel(filename: string, html: string): Promise<void> {
  return exportFile(filename, '\uFEFF' + html, 'application/vnd.ms-excel;charset=utf-8');
}
