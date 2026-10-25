import { describe, expect, it } from 'vitest';
import { crc32, encodeGreyPng } from './lightmapPng.ts';

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** zlib "stored" (uncompressed) deflate: a valid stream with no compressor needed in the test. */
function zlibStore(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const part = data.subarray(b * 65535, Math.min(data.length, (b + 1) * 65535));
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 0xff;
    out[o++] = part.length >>> 8;
    out[o++] = ~part.length & 0xff;
    out[o++] = (~part.length >>> 8) & 0xff;
    out.set(part, o);
    o += part.length;
  }
  let a = 1;
  let c = 0;
  for (const x of data) {
    a = (a + x) % 65521;
    c = (c + a) % 65521;
  }
  new DataView(out.buffer).setUint32(o, ((c << 16) | a) >>> 0);
  return out;
}

/** Inverse of `zlibStore`. */
function zlibUnstore(z: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let o = 2;
  for (;;) {
    const final = z[o]! & 1;
    const len = z[o + 1]! | (z[o + 2]! << 8);
    parts.push(z.subarray(o + 5, o + 5 + len));
    o += 5 + len;
    if (final) break;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

/** Minimal PNG reader for the encoder's output: chunks (CRC-checked) → unfiltered pixels. */
function decode(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let idat: Uint8Array = new Uint8Array(0);
  const types: string[] = [];
  while (o < png.length) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const body = png.subarray(o + 8, o + 8 + len);
    expect(view.getUint32(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
    types.push(type);
    if (type === 'IHDR') {
      width = view.getUint32(o + 8);
      height = view.getUint32(o + 12);
      expect(Array.from(body.subarray(8))).toEqual([8, 0, 0, 0, 0]); // 8-bit grey
    }
    if (type === 'IDAT') idat = body;
    o += 12 + len;
  }
  expect(types).toEqual(['IHDR', 'IDAT', 'IEND']);
  const raw = zlibUnstore(idat);
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (width + 1)]!;
    for (let x = 0; x < width; x++) {
      const r = raw[y * (width + 1) + 1 + x]!;
      const a = x > 0 ? px[y * width + x - 1]! : 0;
      const b = y > 0 ? px[(y - 1) * width + x]! : 0;
      const c = x > 0 && y > 0 ? px[(y - 1) * width + x - 1]! : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      px[y * width + x] = (r + pred) & 0xff;
    }
  }
  return { width, height, pixels: px };
}

describe('lightmap PNG encoder', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
    expect(crc32(ascii('IEND'))).toBe(0xae426082);
  });

  it('round-trips pixels through every filter type', () => {
    const w = 37;
    const h = 23;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Gradients (Sub/Up/Average/Paeth win somewhere) plus noise rows (None wins).
        px[y * w + x] =
          y % 5 === 4 ? (x * 97 + y * 31) & 0xff : (x * 7 + y * 3 + (x * y) / 8) & 0xff;
      }
    }
    const out = decode(encodeGreyPng(px, w, h, zlibStore));
    expect(out.width).toBe(w);
    expect(out.height).toBe(h);
    expect(out.pixels).toEqual(px);
  });

  it('rejects a buffer that does not match the size', () => {
    expect(() => encodeGreyPng(new Uint8Array(5), 2, 2, zlibStore)).toThrow(/2×2/);
  });
});
