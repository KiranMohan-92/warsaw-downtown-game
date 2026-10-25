import { K_WALL, type Feature } from './facadeReliefGrid.ts';
import type { Box2 } from './facadeReliefGrid.ts';
import type { FacadeFace } from './facadeRelief.ts';

const PORTICO_Y0 = 12;
const PORTICO_Y1 = 16;
const PORTICO_MIN_LEN = 32;
const PORTICO_MAX_LEN = 36;
const PORTICO_EAST_X = 52;
const PORTICO_MIN_Z = -18.2;
const PORTICO_MAX_Z = 16.2;
const PORTICO_COLUMN_X = 51.5;
const PORTICO_COLUMN_Z = [-15, -11, -7, -3, 1, 5, 9, 13] as const;

const BOSS = { width: 2.28, y0: 12.78, y1: 14.2, frame: -0.045, inset: -0.115 } as const;
const BOSS_INSET = { x: 0.22, y: 0.2 } as const;
const DENTIL = { width: 0.56, height: 0.16, gap: 1.84, y1: 14.52, o: -0.035 } as const;

const near = (a: number, b: number, e: number): boolean => Math.abs(a - b) <= e;
const clampBox = (b: Box2, bounds: Box2): Box2 | null => {
  const c = {
    x0: Math.max(bounds.x0, b.x0),
    x1: Math.min(bounds.x1, b.x1),
    y0: Math.max(bounds.y0, b.y0),
    y1: Math.min(bounds.y1, b.y1),
  };
  return c.x1 - c.x0 > 1e-6 && c.y1 - c.y0 > 1e-6 ? c : null;
};

function worldZRange(f: FacadeFace): { min: number; max: number } {
  const z1 = f.az + f.dz * f.len;
  return { min: Math.min(f.az, z1), max: Math.max(f.az, z1) };
}

export function isPalacePorticoFriezeFace(f: FacadeFace): boolean {
  if (f.style !== 'monumental') return false;
  if (!near(f.y0, PORTICO_Y0, 0.02) || !near(f.y1, PORTICO_Y1, 0.02)) return false;
  if (f.len < PORTICO_MIN_LEN || f.len > PORTICO_MAX_LEN) return false;
  if (f.dz < 0.98 || Math.abs(f.dx) > 0.05) return false;
  if (f.cover.length > 0) return false;
  const z = worldZRange(f);
  const midX = f.ax + (f.dx * f.len) / 2;
  return (
    near(midX, PORTICO_EAST_X, 0.8) &&
    near(z.min, PORTICO_MIN_Z, 0.4) &&
    near(z.max, PORTICO_MAX_Z, 0.4)
  );
}

export function palacePorticoColumnPositions(f: FacadeFace): number[] {
  return PORTICO_COLUMN_Z.map((z) => (PORTICO_COLUMN_X - f.ax) * f.dx + (z - f.az) * f.dz);
}

export function palacePorticoFriezeFeatures(f: FacadeFace, field: Box2): Feature[] {
  if (!isPalacePorticoFriezeFace(f)) return [];
  const bounds = {
    x0: Math.max(field.x0, 1.05),
    x1: Math.min(field.x1, f.len - 1.05),
    y0: field.y0,
    y1: field.y1,
  };
  const out: Feature[] = [];
  const add = (box: Box2, o: number): void => {
    const c = clampBox(box, bounds);
    if (c) out.push({ ...c, o, k: K_WALL });
  };
  for (const x of palacePorticoColumnPositions(f)) {
    add({ x0: x - BOSS.width / 2, x1: x + BOSS.width / 2, y0: BOSS.y0, y1: BOSS.y1 }, BOSS.frame);
    add(
      {
        x0: x - BOSS.width / 2 + BOSS_INSET.x,
        x1: x + BOSS.width / 2 - BOSS_INSET.x,
        y0: BOSS.y0 + BOSS_INSET.y,
        y1: BOSS.y1 - BOSS_INSET.y,
      },
      BOSS.inset,
    );
  }
  const y0 = DENTIL.y1 - DENTIL.height;
  for (let x = bounds.x0 + 0.38; x + DENTIL.width <= bounds.x1 - 0.38; x += DENTIL.gap) {
    add({ x0: x, x1: x + DENTIL.width, y0, y1: DENTIL.y1 }, DENTIL.o);
  }
  return out;
}
