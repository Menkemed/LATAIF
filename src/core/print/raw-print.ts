// Dünner Wrapper um den Tauri-Command `print_raw_zpl` (Windows Raw-Spooler).
// Sendet ZPL-Bytes am Treiber vorbei direkt an den Zebra (Datatype RAW).

interface InvokeModule {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function tauri(): Promise<InvokeModule | null> {
  if (!isTauri()) return null;
  return (await import('@tauri-apps/api/core')) as unknown as InvokeModule;
}

/** Läuft die App nativ (Tauri) — nur dann ist Raw-Druck verfügbar. */
export function canRawPrint(): boolean {
  return isTauri();
}

const PRINTER_LS_KEY = 'lataif.tag_printer_name';
/** Default-Druckername (User-Setup). Über localStorage überschreibbar. */
export const DEFAULT_TAG_PRINTER = 'Zebra ZD220 (203 dpi) - ZPL';

export function getTagPrinterName(): string {
  try {
    return localStorage.getItem(PRINTER_LS_KEY) || DEFAULT_TAG_PRINTER;
  } catch {
    return DEFAULT_TAG_PRINTER;
  }
}
export function setTagPrinterName(name: string): void {
  try { localStorage.setItem(PRINTER_LS_KEY, name); } catch { /* ignore */ }
}

/**
 * Schickt ZPL als RAW an den benannten Drucker.
 * @returns Anzahl geschriebener Bytes
 * @throws wenn nicht in Tauri ODER der Spooler-Aufruf fehlschlägt
 */
export async function printRawZpl(zpl: string, printer?: string): Promise<number> {
  const t = await tauri();
  if (!t) throw new Error('Raw-Druck nur in der Desktop-App verfügbar (nicht im Browser).');
  const printerName = printer || getTagPrinterName();
  const written = (await t.invoke('print_raw_zpl', { printer: printerName, zpl })) as number;
  return written;
}
