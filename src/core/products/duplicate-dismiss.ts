// SSOT — woran die Duplikatspruefung erkennt, dass sie DIESELBE Eingabe schon gezeigt hat.
//
// Drei Bildschirme legen Artikel an (Collection, der Anlegen-Dialog und die Kommissionsware) und
// alle drei fuehren dieselbe Live-Pruefung: tippt der Benutzer etwas, das nach einem vorhandenen
// Artikel aussieht, erscheint der Hinweis. Damit er nicht sofort wieder aufspringt, merken sie
// sich den Fingerabdruck der Eingabe, die der Benutzer bereits entschieden hat.
//
// Genau dort lag der Fehler: nach "Copy details" wurden Marke, Name und Merkmale des GEFUNDENEN
// Artikels ins Formular uebernommen — der Fingerabdruck war danach also ein anderer als der, den
// man sich gerade gemerkt hatte. Die Pruefung lief erneut, fand denselben Artikel (jetzt sogar
// noch aehnlicher), und der Hinweis erschien ein zweites Mal.
//
// Deshalb steht hier beides an einer Stelle: wie kopiert wird, und welcher Fingerabdruck danach
// gilt. So koennen die beiden nicht auseinanderlaufen.

/** Die Felder, aus denen ein Artikel-Fingerabdruck besteht. */
export interface FingerprintSource {
  brand?: string | null;
  name?: string | null;
  sku?: string | null;
  attributes?: Record<string, unknown> | null;
}

const norm = (v: unknown): string => String(v ?? '').trim().toUpperCase();

/** Der Fingerabdruck einer Formulareingabe — eine Formel, von allen drei Bildschirmen benutzt. */
export function duplicateFingerprint(form: FingerprintSource | null | undefined): string {
  const attrs = (form?.attributes || {}) as Record<string, unknown>;
  return [
    form?.brand, form?.name, form?.sku,
    attrs.reference_number, attrs.serial_number,
    attrs.weight, attrs.karat, attrs.item_type,
  ].map(norm).join('|');
}

/**
 * Die Merkmale, die "Copy details" uebernimmt.
 *
 * Die Seriennummer bleibt ausdruecklich zurueck: sie gehoert zum physischen Stueck, und kopiert
 * wird ja gerade, weil es ein ZWEITES Stueck desselben Modells ist.
 */
export function copiedAttributes(src: FingerprintSource | null | undefined): Record<string, unknown> {
  const out = { ...((src?.attributes || {}) as Record<string, unknown>) };
  delete out.serial_number;
  delete (out as { serialNo?: unknown }).serialNo;
  return out;
}

/**
 * Der Fingerabdruck, den das Formular NACH einem "Copy details" traegt.
 *
 * Genau dieser Wert gehoert in den "schon entschieden"-Merker — nicht der von vorher. Die
 * Uebernahme selbst benutzt `copiedAttributes`, also beschreibt diese Funktion denselben Zustand,
 * den der Bildschirm gleich hat: Marke und Name vom gefundenen Artikel, dessen Merkmale ueber die
 * eigenen gelegt, und die eigene SKU unangetastet (die wird nie kopiert).
 */
export function fingerprintAfterCopy(
  form: FingerprintSource | null | undefined,
  src: FingerprintSource | null | undefined,
): string {
  return duplicateFingerprint({
    brand: src?.brand,
    name: src?.name,
    sku: form?.sku,
    attributes: { ...((form?.attributes || {}) as Record<string, unknown>), ...copiedAttributes(src) },
  });
}
