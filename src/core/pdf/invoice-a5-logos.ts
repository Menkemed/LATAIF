// ════════════════════════════════════════════════════════════════════════════
// INVOICE-A5 — die Bilder des Rechnungskopfs: Emblem (Mitte), Schriftzug Englisch (links) und
// Arabisch (rechts), aus den Vorlagen der Firma zugeschnitten. Wie beim Logo des bisherigen PDFs
// werden sie vorab als Daten-URL geladen, damit der Druck-iframe nichts nachladen muss; bis dahin
// gilt die Adresse der Datei.
// ════════════════════════════════════════════════════════════════════════════
import emblemUrl from '@/assets/invoice-emblem.png';
import nameEnUrl from '@/assets/invoice-name-en.png';
import nameArUrl from '@/assets/invoice-name-ar.png';
import type { InvoiceA5Logos } from './invoice-a5';

const logos: Required<InvoiceA5Logos> = { emblem: emblemUrl, nameEn: nameEnUrl, nameAr: nameArUrl };

for (const k of Object.keys(logos) as Array<keyof InvoiceA5Logos>) {
  fetch(logos[k])
    .then((r) => r.blob())
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }))
    .then((dataUrl) => { logos[k] = dataUrl; })
    .catch(() => { /* die Adresse der Datei bleibt */ });
}

export function invoiceA5Logos(): InvoiceA5Logos {
  return { ...logos };
}
