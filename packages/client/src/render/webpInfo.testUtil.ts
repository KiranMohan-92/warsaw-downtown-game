/** Test helper: size, alpha and codec of a WebP file, read from its RIFF header (no decoder). */
export interface WebpInfo {
  width: number;
  height: number;
  /** Has an alpha channel (VP8X + ALPH chunk, or a VP8L image flagged alpha-used). */
  alpha: boolean;
  /** Lossless (VP8L) image data rather than lossy VP8. */
  lossless: boolean;
}

export function webpInfo(buf: Buffer): WebpInfo {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a WebP file');
  }
  let width = 0;
  let height = 0;
  let alpha = false;
  let lossless = false;
  let codec = false;
  for (let i = 12; i + 8 <= buf.length;) {
    const tag = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const d = i + 8;
    if (tag === 'VP8X') {
      alpha = (buf[d]! & 0x10) !== 0;
      width = buf.readUIntLE(d + 4, 3) + 1;
      height = buf.readUIntLE(d + 7, 3) + 1;
    } else if (tag === 'VP8 ') {
      if (buf[d + 3] !== 0x9d || buf[d + 4] !== 0x01 || buf[d + 5] !== 0x2a) {
        throw new Error('bad VP8 start code');
      }
      width ||= buf.readUInt16LE(d + 6) & 0x3fff;
      height ||= buf.readUInt16LE(d + 8) & 0x3fff;
      codec = true;
    } else if (tag === 'VP8L') {
      if (buf[d] !== 0x2f) throw new Error('bad VP8L signature');
      const bits = buf.readUInt32LE(d + 1);
      width ||= (bits & 0x3fff) + 1;
      height ||= ((bits >>> 14) & 0x3fff) + 1;
      alpha ||= ((bits >>> 28) & 1) === 1;
      lossless = true;
      codec = true;
    }
    i = d + size + (size & 1);
  }
  if (!codec) throw new Error('no VP8/VP8L image chunk');
  return { width, height, alpha, lossless };
}
