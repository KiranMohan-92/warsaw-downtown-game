export interface TreeMip {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Alpha coverage resampled to a lower normal-atlas resolution; RGB is unused by normalMips. */
export function coverageWeightsForSize(
  color: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  if (
    targetWidth <= 0 ||
    targetHeight <= 0 ||
    width % targetWidth !== 0 ||
    height % targetHeight !== 0
  )
    throw new Error('Tree normal coverage size must divide the colour atlas');
  const sx = width / targetWidth;
  const sy = height / targetHeight;
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++)
    for (let x = 0; x < targetWidth; x++) {
      let alpha = 0;
      for (let yy = y * sy; yy < (y + 1) * sy; yy++)
        for (let xx = x * sx; xx < (x + 1) * sx; xx++) alpha += color[(yy * width + xx) * 4 + 3]!;
      out[(y * targetWidth + x) * 4 + 3] = Math.round(alpha / (sx * sy));
    }
  return out;
}

function halfLevel(px: Float32Array, w: number, h: number, stride = 4): Float32Array<ArrayBuffer> {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh * stride);
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const src = (Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx)) * stride;
          const dst = (y * nw + x) * stride;
          for (let c = 0; c < stride; c++) out[dst + c] = out[dst + c]! + px[src + c]! * 0.25;
        }
  return out;
}

function frameCoverage(
  px: Float32Array,
  w: number,
  h: number,
  frames: number,
  f: number,
  k = 1,
): number {
  const fw = w / frames;
  let covered = 0;
  for (let y = 0; y < h; y++)
    for (let x = f * fw; x < (f + 1) * fw; x++) if (px[(y * w + x) * 4 + 3]! * k >= 0.5) covered++;
  return covered / (fw * h);
}

/** Straight RGBA8 levels; each baked view retains its own alpha-test coverage. */
export function coverageMips(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  frames = 1,
): TreeMip[] {
  if (!Number.isInteger(frames) || frames < 1 || width % frames !== 0)
    throw new Error('Tree mip frames must divide the atlas width');
  let px = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) px[i * 4 + c] = (data[i * 4 + c]! / 255) * a;
    px[i * 4 + 3] = a;
  }
  const targets = Array.from({ length: frames }, (_, f) =>
    frameCoverage(px, width, height, frames, f),
  );
  const totalTarget = frameCoverage(px, width, height, 1, 0);
  const levels: TreeMip[] = [];
  let w = width;
  let h = height;
  for (;;) {
    // Below one texel per frame, the atlas must reduce as a whole like an ordinary mip chain.
    const n = w >= frames ? frames : 1;
    const scales = Array.from({ length: n }, (_, f) => {
      const target = n === frames ? targets[f]! : totalTarget;
      if (!levels.length || frameCoverage(px, w, h, n, f) >= target) return 1;
      let lo = 1;
      let hi = 16;
      for (let it = 0; it < 16; it++) {
        const mid = (lo + hi) / 2;
        if (frameCoverage(px, w, h, n, f, mid) >= target) hi = mid;
        else lo = mid;
      }
      return hi;
    });
    const out = levels.length ? new Uint8Array(w * h * 4) : new Uint8Array(data);
    if (levels.length)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const a = px[i + 3]!;
          for (let c = 0; c < 3; c++)
            out[i + c] = a > 1e-4 ? Math.round(Math.min(1, px[i + c]! / a) * 255) : 0;
          out[i + 3] = Math.round(Math.min(1, a * scales[Math.floor(x / (w / n))]!) * 255);
        }
    levels.push({ data: out, width: w, height: h });
    if (w === 1 && h === 1) return levels;
    px = halfLevel(px, w, h);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

/** Average decoded normals using original coverage, never the rescaled alpha-test mips. */
export function normalMips(
  normals: Uint8ClampedArray | Uint8Array,
  color: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  ambientOcclusion = false,
): TreeMip[] {
  // AO occupies the encoded alpha channel, so original colour coverage needs its own weight.
  const stride = ambientOcclusion ? 5 : 4;
  let px = new Float32Array(width * height * stride);
  for (let i = 0; i < width * height; i++) {
    const a = color[i * 4 + 3]! / 255;
    for (let c = 0; c < 3; c++) px[i * stride + c] = ((normals[i * 4 + c]! / 255) * 2 - 1) * a;
    px[i * stride + 3] = a;
    if (ambientOcclusion) px[i * stride + 4] = (normals[i * 4 + 3]! / 255) * a;
  }
  const levels: TreeMip[] = [{ data: new Uint8Array(normals), width, height }];
  let w = width;
  let h = height;
  while (w > 1 || h > 1) {
    px = halfLevel(px, w, h, stride);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      const p = i * stride;
      const length = Math.hypot(px[p]!, px[p + 1]!, px[p + 2]!);
      for (let c = 0; c < 3; c++) {
        const normal = length > 1e-6 ? px[p + c]! / length : c === 1 ? 1 : 0;
        out[j + c] = Math.round((normal * 0.5 + 0.5) * 255);
      }
      const coverage = px[p + 3]!;
      out[j + 3] = ambientOcclusion
        ? Math.round((coverage > 1e-6 ? px[p + 4]! / coverage : 1) * 255)
        : Math.round(coverage * 255);
    }
    levels.push({ data: out, width: w, height: h });
  }
  return levels;
}
