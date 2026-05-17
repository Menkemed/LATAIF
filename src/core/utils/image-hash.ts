// Plan §Image-Duplicate-Detection
// ─────────────────────────────────────────────────────────────────────────
// Perceptual Hash (pHash) auf Basis 2D-DCT — liefert einen 64-bit Fingerprint
// pro Bild. Identische oder nur leicht modifizierte (Crop/Compression/Color-
// shift) Aufnahmen haben sehr ähnliche Hashes (Hamming-Distance ≤ 6-8).
//
// Pro Hash ~10-50ms — billig genug für Live-Compute beim Upload und für
// Lazy-Backfill über die gesamte Collection. Keine externen Dependencies,
// reines Canvas + Float64Array.
//
// Format: 16-stelliger Hex-String (64 bits). Hamming-Distance über XOR der
// BigInts gerechnet.

/** Resize, gray-out und liefere die 32x32 Luminanz-Matrix. */
function imageToLuminance(img: HTMLImageElement | HTMLCanvasElement, size = 32): Float64Array {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const lum = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    // ITU-R BT.601 luma
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return lum;
}

/** 1D-DCT-II auf einem Vektor der Länge N. */
function dct1d(input: Float64Array, N: number): Float64Array {
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
    }
    out[k] = sum;
  }
  return out;
}

/** 2D-DCT-II über eine NxN-Matrix (Flat, row-major). */
function dct2d(input: Float64Array, N: number): Float64Array {
  // Erst row-DCT, dann column-DCT auf dem Ergebnis.
  const rowDct = new Float64Array(N * N);
  const row = new Float64Array(N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) row[c] = input[r * N + c];
    const d = dct1d(row, N);
    for (let c = 0; c < N; c++) rowDct[r * N + c] = d[c];
  }
  const out = new Float64Array(N * N);
  const col = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    for (let r = 0; r < N; r++) col[r] = rowDct[r * N + c];
    const d = dct1d(col, N);
    for (let r = 0; r < N; r++) out[r * N + c] = d[r];
  }
  return out;
}

/** Berechnet pHash aus einer Image-Quelle. Liefert 16-stelligen Hex-String. */
async function computeHashFromSource(src: string | Blob): Promise<string> {
  const img = await loadImage(src);
  const N = 32;
  const lum = imageToLuminance(img, N);
  const dct = dct2d(lum, N);
  // Top-left 8x8 (ohne DC bei [0,0]) als Frequenz-Signature.
  const sig = new Float64Array(64);
  let idx = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      sig[idx++] = dct[r * N + c];
    }
  }
  // Median berechnen (DC-Coefficient bei [0] ausgeschlossen, da viel größer als der Rest).
  const sorted = [...sig.slice(1)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // 64-bit Hash: jedes Bit = (sig[i] > median).
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    if (sig[i] > median) hash |= (1n << BigInt(i));
  }
  // Hex-Pad auf 16 Stellen.
  return hash.toString(16).padStart(16, '0');
}

/** Lädt Image aus Data-URL, Blob oder http-URL. */
function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
}

/**
 * Public: Hash aus Data-URL/URL/Blob. Bei Fehler (broken image etc.) wirft —
 * Caller fängt und überspringt das Item.
 */
export async function computeImageHash(src: string | Blob): Promise<string> {
  return computeHashFromSource(src);
}

/** Hamming-Distance zwischen zwei 64-bit Hex-Hashes. 0 = identisch, 64 = inverse. */
export function hashDistance(a: string, b: string): number {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  const xa = BigInt('0x' + a);
  const xb = BigInt('0x' + b);
  let x = xa ^ xb;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Threshold: ≤6 = sehr ähnlich (gleiche Aufnahme), ≤12 = visuell ähnlich. */
export const HASH_IDENTICAL_THRESHOLD = 6;
export const HASH_SIMILAR_THRESHOLD = 12;
