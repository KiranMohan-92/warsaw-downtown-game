import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  coverageMips,
  coverageWeightsForSize,
  normalMips,
} from '../../packages/client/src/render/treeTextureMips.ts';

const root = 'packages/client/public/models/trees/';
const manifest = JSON.parse(readFileSync(`${root}trees.json`, 'utf8'));
function decode(path) {
  const result = spawnSync(
    process.env.TREE_CHECK_PYTHON || 'C:/Python314/python.exe',
    [
      '-c',
      'from PIL import Image; import sys,struct; im=Image.open(sys.argv[1]).convert("RGBA"); sys.stdout.buffer.write(struct.pack("<II", *im.size)+im.tobytes())',
      path,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return {
    width: result.stdout.readUInt32LE(0),
    height: result.stdout.readUInt32LE(4),
    data: new Uint8Array(result.stdout.subarray(8)),
  };
}
function coverage(level, frames) {
  return Array.from({ length: frames }, (_, f) => {
    let count = 0;
    const fw = level.width / frames;
    for (let y = 0; y < level.height; y++)
      for (let x = f * fw; x < (f + 1) * fw; x++)
        if (level.data[(y * level.width + x) * 4 + 3] >= 128) count++;
    return count / (fw * level.height);
  });
}
const rows = [];
for (const [id, spec] of Object.entries(manifest.species)) {
  const color = decode(`${root}${id}_impostor.webp`);
  const normal = decode(`${root}${id}_impostor_n.webp`);
  if (color.width % normal.width !== 0 || color.height % normal.height !== 0)
    throw new Error(`${id}: normal atlas dimensions do not divide the colour atlas`);
  const framed = coverageMips(color.data, color.width, color.height, spec.frame.frames);
  const global = coverageMips(color.data, color.width, color.height);
  const normalCoverage =
    color.width === normal.width && color.height === normal.height
      ? color.data
      : coverageWeightsForSize(color.data, color.width, color.height, normal.width, normal.height);
  const normals = normalMips(
    normal.data,
    normalCoverage,
    normal.width,
    normal.height,
    spec.frame.ambientOcclusion,
  );
  const leaf = decode(`${root}leaf_${spec.leaf}.webp`);
  const leaves = coverageMips(leaf.data, leaf.width, leaf.height);
  const baseCoverage = coverage(framed[0], spec.frame.frames);
  for (const level of framed.filter((l) => l.width >= spec.frame.frames)) {
    if (coverage(level, spec.frame.frames).some((v, i) => v < baseCoverage[i]))
      throw new Error(`${id}: a baked view lost its base coverage`);
  }
  if (
    framed.reduce((n, l) => n + l.data.length, 0) !== global.reduce((n, l) => n + l.data.length, 0)
  )
    throw new Error(`${id}: mip storage budget changed`);
  let maxNormalLengthError = 0;
  for (const level of normals.slice(1))
    for (let i = 0; i < level.data.length; i += 4) {
      const length = Math.hypot(...[0, 1, 2].map((c) => (level.data[i + c] / 255) * 2 - 1));
      maxNormalLengthError = Math.max(maxNormalLengthError, Math.abs(length - 1));
    }
  if (maxNormalLengthError > 0.014) throw new Error(`${id}: encoded normals are not unit length`);
  let minAO = 255;
  if (spec.frame.ambientOcclusion)
    for (const level of normals)
      for (let i = 3; i < level.data.length; i += 4) minAO = Math.min(minAO, level.data[i]);
  if (spec.frame.ambientOcclusion && minAO < 166)
    throw new Error(`${id}: packed AO mip lost its bounds`);
  if (
    !Buffer.from(framed[0].data).equals(Buffer.from(color.data)) ||
    !Buffer.from(normals[0].data).equals(Buffer.from(normal.data))
  )
    throw new Error(`${id}: base pixels changed`);
  rows.push({
    id,
    atlas: [color.width, color.height],
    leaf: [leaf.width, leaf.height],
    colorBytes: framed.reduce((n, l) => n + l.data.length, 0),
    originalColorBytes: global.reduce((n, l) => n + l.data.length, 0),
    normalBytes: normals.reduce((n, l) => n + l.data.length, 0),
    leafBytes: leaves.reduce((n, l) => n + l.data.length, 0),
    maxNormalLengthError,
    packedAO: !!spec.frame.ambientOcclusion,
    minAO: spec.frame.ambientOcclusion ? minAO / 255 : null,
    coverage: framed
      .filter((l) => l.width >= spec.frame.frames)
      .map((l, i) => ({
        width: l.width,
        height: l.height,
        perView: coverage(l, spec.frame.frames),
        globalBefore: coverage(global[i], spec.frame.frames),
      })),
  });
}
const receipt = {
  measuredAt: new Date().toISOString(),
  scope: 'Shipped atlas filtering; no browser performance claim',
  rows,
};
writeFileSync(
  process.argv[2] || 'tools/assets/build/market-tree-filtering-assets-20261007.json',
  JSON.stringify(receipt, null, 2),
);
console.log(
  JSON.stringify(
    rows.map(({ id, atlas, colorBytes, originalColorBytes, maxNormalLengthError, coverage }) => ({
      id,
      atlas,
      colorBytes,
      originalColorBytes,
      maxNormalLengthError,
      improvedViewLevels: coverage.reduce(
        (n, l) => n + l.perView.filter((v, i) => v > l.globalBefore[i]).length,
        0,
      ),
    })),
    null,
    2,
  ),
);
