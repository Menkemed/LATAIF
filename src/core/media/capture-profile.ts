// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-12 — das Aufnahmeprofil des Desktops an EINER Stelle.
//
// Jede Maske wählt Fotos über `ImageUpload` aus; hier steht, in welcher Fassung sie reisen: längste
// Seite ≤ 800 px, JPEG 0,7 (dieselben Werte wie bisher), Transparenz auf Weiß (wie der Normalisierer),
// eine unlesbare Datei ist ein Fehler statt eines stillen Abbruchs.
//
// Bewusst NICHT das Profil des Handys (1600 px / 0,85), gemessen (Release, `record_image` Bench): eine
// 1600-px-Aufnahme braucht im Normalisierer ~1,6 s je Foto (Hauptbild) statt ~0,07 s bei 800 px. Ein
// Artikel mit 8 Fotos vom zweiten Rechner wird im Primary INNERHALB der 20-s-Frist eines Befehls
// normalisiert (Hauptbild + Vorschau je Foto) — mit 1600 px wären das ~13,5 s nur für die Bilder. Das
// Handy darf größer aufnehmen: sein Weg (Inbox → Übernahme am Desktop) hat keine Brückenfrist, und seine
// Aufnahme ist die Vorlage der KI-Erkennung. Gespeichert wird auf beiden Wegen dasselbe: ≤ 100 000 B.
// ════════════════════════════════════════════════════════════════════════════

export const CAPTURE_MAX_DIM = 800;
export const CAPTURE_JPEG_QUALITY = 0.7;

/** Die Zielmaße: längste Seite ≤ `CAPTURE_MAX_DIM`, nie vergrößert. */
export function captureSize(width: number, height: number): { width: number; height: number } {
  const ratio = Math.min(CAPTURE_MAX_DIM / width, CAPTURE_MAX_DIM / height, 1);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

/** Eine ausgewählte Datei → JPEG-Daten-URL im Aufnahmeprofil. Eine unlesbare Datei ist ein Fehler. */
export function captureImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const { width, height } = captureSize(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no canvas')); return; }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY));
      };
      img.onerror = () => reject(new Error('unreadable image'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('unreadable file'));
    reader.readAsDataURL(file);
  });
}
