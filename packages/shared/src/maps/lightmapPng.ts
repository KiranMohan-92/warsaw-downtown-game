/**
 * Minimal 8-bit greyscale PNG encoder for baked lightmaps (no dependencies). Pure: the caller
 * supplies the zlib `deflate` (the baker passes `node:zlib` `deflateSync`), so this module stays
 * browser-safe like the rest of `shared` and is unit-testable without Node APIs.
 *
 * Each row picks the PNG filter (None/Sub/Up/Average/Paeth) with the smallest sum of absolute
 * residuals — the standard libpng heuristic; smooth occlusion compresses several times better.
 */

let crcTable: Uint32Array | null = null;

/** CRC-32 (ISO-HDLC / PNG). */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Filtered scanlines (filter byte + residuals per row), ready for deflate. */
export function filterRows(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(height * (width + 1));
  const trial = new Uint8Array(width);
  const best = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const prev = (y - 1) * width;
    let bestScore = Infinity;
    let bestType = 0;
    for (let type = 0; type < 5; type++) {
      let score = 0;
      for (let x = 0; x < width; x++) {
        const cur = pixels[row + x]!;
        const a = x > 0 ? pixels[row + x - 1]! : 0;
        const b = y > 0 ? pixels[prev + x]! : 0;
        const c = x > 0 && y > 0 ? pixels[prev + x - 1]! : 0;
        const pred =
          type === 0
            ? 0
            : type === 1
              ? a
              : type === 2
                ? b
                : type === 3
                  ? (a + b) >> 1
                  : paeth(a, b, c);
        const r = (cur - pred) & 0xff;
        trial[x] = r;
        score += r < 128 ? r : 256 - r;
      }
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
        best.set(trial);
      }
    }
    out[y * (width + 1)] = bestType;
    out.set(best, y * (width + 1) + 1);
  }
  return out;
}

/** Encode a `width × height` single-channel 8-bit image (row-major, top row first) as PNG. */
export function encodeGreyPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  deflate: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  if (pixels.length !== width * height) {
    throw new Error(`png: ${pixels.length} bytes for a ${width}×${height} image`);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate(filterRows(pixels, width, height))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
