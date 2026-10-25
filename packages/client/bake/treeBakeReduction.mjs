/** Offline reduction only; the normal atlas alpha is AO, while colour alpha is coverage. */
const linear = Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const encode = (c) =>
  Math.round(
    Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)) *
      255,
  );

/** Input arrays are bottom-up WebGL readbacks; output is top-down PNG/DataTexture data. */
export function reduceTreeView(color, normals, ao, size, factor) {
  if (!Number.isInteger(factor) || factor < 1 || size % factor)
    throw new Error('Reduction factor must divide the source size');
  const bytes = size * size * 4;
  if ([color, normals, ao].some((a) => a.length !== bytes))
    throw new Error('Tree source arrays must have identical RGBA dimensions');
  const outSize = size / factor;
  const cOut = new Uint8Array(outSize * outSize * 4);
  const nOut = new Uint8Array(cOut.length);
  for (let y = 0; y < outSize; y++)
    for (let x = 0; x < outSize; x++) {
      const rgb = [0, 0, 0];
      const n = [0, 0, 0];
      let weight = 0;
      let ambient = 0;
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) {
          const i = ((size - 1 - (y * factor + dy)) * size + x * factor + dx) * 4;
          const a = color[i + 3] / 255;
          weight += a;
          ambient += (ao[i] / 255) * a;
          for (let ch = 0; ch < 3; ch++) {
            rgb[ch] += linear[color[i + ch]] * a;
            n[ch] += ((normals[i + ch] / 255) * 2 - 1) * a;
          }
        }
      const dst = (y * outSize + x) * 4;
      const length = Math.hypot(...n);
      for (let ch = 0; ch < 3; ch++) {
        cOut[dst + ch] = weight > 0 ? encode(rgb[ch] / weight) : 0;
        const unit = length > 1e-6 ? n[ch] / length : ch === 1 ? 1 : 0;
        nOut[dst + ch] = Math.round((unit * 0.5 + 0.5) * 255);
      }
      cOut[dst + 3] = Math.round((weight / (factor * factor)) * 255);
      // Conservative candidate AO; clamp prevents interiors becoming opaque black masses.
      nOut[dst + 3] = Math.round((weight > 0 ? Math.max(0.65, ambient / weight) : 1) * 255);
    }
  return { color: cOut, normals: nOut, size: outSize };
}

export function treeReductionChecks() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const color = new Uint8Array(16);
  color.set([240, 100, 30, 255]);
  const normals = new Uint8Array(16);
  normals.set([255, 128, 128, 255]);
  normals.set([0, 128, 128, 255], 4);
  const ao = new Uint8Array(16);
  ao.set([204, 204, 204, 255]);
  const sparse = reduceTreeView(color, normals, ao, 2, 2);
  assert(
    sparse.color[0] === 240 && sparse.color[1] === 100 && sparse.color[3] === 64,
    'Transparent samples contaminated covered colour',
  );
  assert(
    sparse.normals[0] === 255 && sparse.normals[3] === 204,
    'Transparent normals or AO contaminated a covered sample',
  );
  const empty = reduceTreeView(new Uint8Array(16), normals, ao, 2, 2);
  assert(
    empty.color[3] === 0 && empty.normals[1] === 255 && empty.normals[3] === 255,
    'Empty pixels must be transparent with neutral normal/AO',
  );
  const blend = new Uint8Array(16);
  blend.set([0, 0, 0, 255]);
  blend.set([255, 255, 255, 255], 4);
  const linearAverage = reduceTreeView(blend, normals, new Uint8Array(16).fill(255), 2, 2);
  assert(linearAverage.color[0] === 188, 'Colour reduction must average linear RGB');
  const oriented = reduceTreeView(
    new Uint8Array([20, 30, 40, 255]),
    new Uint8Array([128, 255, 128, 255]),
    new Uint8Array(4).fill(255),
    1,
    1,
  );
  assert(
    oriented.color[0] === 20 && oriented.normals[1] === 255,
    'One-texel identity reduction changed input',
  );
  const opposingNormals = new Uint8Array(16);
  opposingNormals.set([255, 127, 127, 255]);
  opposingNormals.set([0, 128, 128, 255], 4);
  const cancelling = reduceTreeView(blend, opposingNormals, new Uint8Array(16).fill(255), 2, 2);
  assert(
    cancelling.normals[0] === 128 && cancelling.normals[1] === 255,
    'Opposing covered vectors need a finite fallback',
  );
  const rows = new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255]);
  const ordered = reduceTreeView(
    rows,
    new Uint8Array(16).fill(255),
    new Uint8Array(16).fill(255),
    2,
    1,
  );
  assert(
    ordered.color[0] === 30 && ordered.color[8] === 10,
    'WebGL rows must flip once for a top-down atlas',
  );
  let rejected = false;
  try {
    reduceTreeView(color, normals, ao, 2, 3);
  } catch {
    rejected = true;
  }
  assert(rejected, 'Invalid reduction dimensions must fail');
  return [
    'covered colour',
    'covered vector/AO',
    'empty fallback',
    'linear colour',
    'identity',
    'opposing normals',
    'row orientation',
    'invalid dimensions',
  ];
}
