import * as THREE from 'three';
import type { MapBox } from '@wd/shared';

export type StallPropMaterial = 'wood' | 'metal' | 'matte' | 'sign';

export interface StallPropPiece {
  geo: THREE.BufferGeometry;
  mat: StallPropMaterial;
  color: number;
  at: [number, number, number];
  rot?: [number, number, number];
}

export const MARKET_SIGN_ATLAS_SIZE = 512;
const ATLAS_GRID = 4;

function rand(canopy: MapBox, salt: number): () => number {
  let s =
    (Math.imul(Math.round(canopy.center.x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^
      Math.round(canopy.center.z * 10) ^
      Math.round(canopy.center.y * 10) ^
      salt) |
    0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function rod(r: number, len: number, segments = 6): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, len, segments, 1, true);
}

function signPlane(w: number, h: number, tile: number): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(w, h);
  const uv = geo.getAttribute('uv');
  const tx = tile % ATLAS_GRID;
  const ty = Math.floor(tile / ATLAS_GRID);
  const pad = 0.012;
  for (let i = 0; i < uv.count; i++) {
    const u = (tx + pad + uv.getX(i) * (1 - pad * 2)) / ATLAS_GRID;
    const v = (ty + pad + uv.getY(i) * (1 - pad * 2)) / ATLAS_GRID;
    uv.setXY(i, u, 1 - v);
  }
  return geo;
}

function priceCard(out: StallPropPiece[], x: number, z: number, tile: number, lean: number): void {
  out.push({
    geo: signPlane(0.26, 0.14, tile),
    mat: 'sign',
    color: 0xffffff,
    at: [x, -1.1, z],
    rot: [lean, 0, 0],
  });
  out.push({
    geo: box(0.018, 0.17, 0.012),
    mat: 'wood',
    color: 0xbba06d,
    at: [x, -1.245, z - 0.01],
  });
}

function receipt(out: StallPropPiece[], x: number, z: number, rot: number, tile: number): void {
  out.push({
    geo: signPlane(0.16, 0.09, tile),
    mat: 'sign',
    color: 0xffffff,
    at: [x, -1.325, z],
    rot: [-Math.PI / 2, 0, rot],
  });
}

function hangingGauge(out: StallPropPiece[], x: number, tile: number): void {
  out.push({
    geo: rod(0.005, 0.28, 5),
    mat: 'metal',
    color: 0x595959,
    at: [x, -0.78, -0.852],
  });
  out.push({
    geo: new THREE.CircleGeometry(0.085, 10),
    mat: 'metal',
    color: 0x8d9492,
    at: [x, -0.95, -0.854],
  });
  out.push({
    geo: signPlane(0.12, 0.12, tile),
    mat: 'sign',
    color: 0xffffff,
    at: [x, -0.95, -0.849],
  });
}

function underCanopyTies(out: StallPropPiece[], rnd: () => number): void {
  const y = -0.36 - rnd() * 0.1;
  for (const x of [-1.24, 1.24]) {
    out.push({
      geo: rod(0.006, 0.5 + rnd() * 0.16, 5),
      mat: 'matte',
      color: 0x24201c,
      at: [x, y, 0.24 + rnd() * 0.38],
    });
    out.push({
      geo: box(0.045, 0.032, 0.022),
      mat: 'matte',
      color: 0x28231f,
      at: [x, y - 0.27, 0.24 + rnd() * 0.38],
    });
  }
  out.push({
    geo: rod(0.004, 2.2, 5),
    mat: 'matte',
    color: 0x171513,
    at: [0, -0.3, 0.7],
    rot: [0, 0, Math.PI / 2],
  });
}

export function buildMarketStallProps(canopy: MapBox): StallPropPiece[] {
  const rnd = rand(canopy, 41);
  const out: StallPropPiece[] = [];

  for (const x of [-0.95, 0, 0.95]) {
    priceCard(
      out,
      x + (rnd() - 0.5) * 0.12,
      0.31 + rnd() * 0.04,
      Math.floor(rnd() * 15),
      (rnd() - 0.5) * 0.08,
    );
  }

  const receiptCount = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < receiptCount; i++) {
    receipt(
      out,
      -1.1 + rnd() * 2.2,
      0.27 + rnd() * 0.05,
      (rnd() - 0.5) * 0.8,
      Math.floor(rnd() * 15),
    );
  }
  if (rnd() > 0.25) hangingGauge(out, -1.22 + rnd() * 2.44, Math.floor(rnd() * 15));
  underCanopyTies(out, rnd);

  return out;
}

let signTexture: THREE.DataTexture | null = null;

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['111', '101', '101', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '010', '010', '111'],
  '2': ['111', '001', '001', '111', '100', '100', '111'],
  '3': ['111', '001', '001', '111', '001', '001', '111'],
  '4': ['101', '101', '101', '111', '001', '001', '001'],
  '5': ['111', '100', '100', '111', '001', '001', '111'],
  '6': ['111', '100', '100', '111', '101', '101', '111'],
  '7': ['111', '001', '001', '010', '010', '010', '010'],
  '8': ['111', '101', '101', '111', '101', '101', '111'],
  '9': ['111', '101', '101', '111', '001', '001', '111'],
  '.': ['000', '000', '000', '000', '000', '110', '110'],
  K: ['101', '101', '110', '100', '110', '101', '101'],
  G: ['111', '100', '100', '101', '101', '101', '111'],
};

const SIGN_TEXT = [
  '4.90KG',
  '7.50KG',
  '12.0KG',
  '6.20KG',
  '3.40KG',
  '8.00KG',
  '5.70KG',
  '9.90KG',
  '2.80KG',
  '14.5KG',
  '1.99KG',
  '11.0KG',
  '6.60KG',
  '3.20KG',
  '8.80KG',
  '0.00KG',
] as const;

function setRect(
  data: Uint8Array,
  n: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: number,
): void {
  for (let y = Math.max(0, y0); y < Math.min(n, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(n, x0 + w); x++) {
      const i = (y * n + x) * 4;
      data[i] = (color >> 16) & 255;
      data[i + 1] = (color >> 8) & 255;
      data[i + 2] = color & 255;
      data[i + 3] = 255;
    }
  }
}

function drawText(
  data: Uint8Array,
  n: number,
  x0: number,
  y0: number,
  text: string,
  color: number,
  scale: number,
): void {
  let x = x0;
  for (const ch of text) {
    const rows = GLYPHS[ch];
    if (!rows) {
      x += scale * 2;
      continue;
    }
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row]!.length; col++) {
        if (rows[row]![col] === '1')
          setRect(data, n, x + col * scale, y0 + row * scale, scale, scale, color);
      }
    }
    x += (rows[0]!.length + 1) * scale;
  }
}

export function createMarketSignTexture(): THREE.DataTexture {
  if (signTexture) return signTexture;
  const n = MARKET_SIGN_ATLAS_SIZE;
  const tile = n / ATLAS_GRID;
  const data = new Uint8Array(n * n * 4);
  const palettes = [
    [0xf7eed1, 0x2d2318, 0xc33a24],
    [0xe9f2e4, 0x24301f, 0x2d7a4a],
    [0xf3e4d7, 0x30231d, 0xd08b24],
    [0xe6edf7, 0x1d2430, 0x3d68c8],
  ] as const;
  for (let ty = 0; ty < ATLAS_GRID; ty++) {
    for (let tx = 0; tx < ATLAS_GRID; tx++) {
      const p = palettes[(tx + ty) % palettes.length]!;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const gx = tx * tile + x;
          const gy = ty * tile + y;
          const i = (gy * n + gx) * 4;
          const edge = x < 5 || y < 5 || x >= tile - 5 || y >= tile - 5;
          const header = y > 12 && y < 27 && x > 12 && x < tile - 12;
          const ink = edge ? p[1] : header ? p[2] : p[0];
          data[i] = (ink >> 16) & 255;
          data[i + 1] = (ink >> 8) & 255;
          data[i + 2] = ink & 255;
          data[i + 3] = 255;
        }
      }
      drawText(data, n, tx * tile + 16, ty * tile + 48, SIGN_TEXT[ty * ATLAS_GRID + tx]!, p[1], 4);
    }
  }
  signTexture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  signTexture.name = 'market-sign-atlas';
  signTexture.colorSpace = THREE.SRGBColorSpace;
  signTexture.generateMipmaps = true;
  signTexture.minFilter = THREE.LinearMipmapLinearFilter;
  signTexture.magFilter = THREE.LinearFilter;
  signTexture.needsUpdate = true;
  return signTexture;
}
