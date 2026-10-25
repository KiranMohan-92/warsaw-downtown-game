import { describe, expect, it } from 'vitest';
import {
  PALACE_TINT,
  placDefilad,
  getMap,
  resolveMap,
  type MapDefinition,
  type MapPrism,
} from '@wd/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  BAY,
  FACADE_STYLES,
  RELIEF_MAX,
  RELIEF_MIN,
  STOREY,
  WINDOW,
  PALACE_WINDOW_TRIM,
  facadeFaces,
  faceRelief,
  keepOut,
  type FaceSegment,
  type FacadeFace,
  type FacadePart,
  type LocalQuad,
} from './facadeRelief.ts';

const BLOCK_TINT = 0xb0a898;

/** A rectangular block prism, x0..x1 × z0..z1, listed CCW in (x, z) (outward = (dz, −dx)). */
function block(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y1: number,
  extra: Partial<MapPrism> = {},
): MapPrism {
  return {
    pts: [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ],
    y0: 0,
    y1,
    mat: 'facade',
    tint: BLOCK_TINT,
    ...extra,
  };
}

function mapOf(...prisms: MapPrism[]): MapDefinition {
  return {
    name: 'facade-test',
    bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
    boxes: [],
    prisms,
    spawns: [],
    dummies: [],
  };
}

const partQuads = (segs: FaceSegment[], part: FacadePart): LocalQuad[] =>
  segs.flatMap((s) => s.parts[part]);
const fronts = (qs: LocalQuad[]): LocalQuad[] => qs.filter((q) => q.axis === 'o');
const area = (qs: LocalQuad[]): number =>
  fronts(qs).reduce((a, q) => a + (q.x1 - q.x0) * (q.y1 - q.y0), 0);
const allQuads = (segs: FaceSegment[]): LocalQuad[] =>
  segs.flatMap((s) => Object.values(s.parts).flat());

describe('facadeFaces', () => {
  it('finds the four walls of a free-standing block, no seams, nothing covering them', () => {
    const faces = facadeFaces(mapOf(block(0, 0, 33, 33, 19.8)), PALACE_TINT);
    expect(faces).toHaveLength(4);
    for (const f of faces) {
      expect(f.len).toBeCloseTo(33, 9);
      expect(f.seam0 || f.seam1).toBe(false);
      expect(f.cover).toEqual([]);
      expect(f.style).toBe('block');
      // Outward normal (dz, −dx) points away from the block's centre.
      const mx = f.ax + (f.dx * f.len) / 2 + f.dz;
      const mz = f.az + (f.dz * f.len) / 2 - f.dx;
      expect(Math.hypot(mx - 16.5, mz - 16.5)).toBeGreaterThan(16.5);
    }
  });

  it('styles the Palace (by its tint) as monumental', () => {
    const faces = facadeFaces(mapOf(block(0, 0, 33, 33, 30, { tint: PALACE_TINT })), PALACE_TINT);
    expect(faces.every((f) => f.style === 'monumental')).toBe(true);
  });

  it('skips walls buried in a neighbour and marks seams between collinear pieces', () => {
    // Two convex pieces of one 40 m wall, same heights: the shared wall is buried both ways.
    const faces = facadeFaces(
      mapOf(block(0, 0, 20, 20, 13.2), block(20, 0, 40, 20, 13.2)),
      PALACE_TINT,
    );
    expect(faces).toHaveLength(6);
    const south = faces.filter((f) => f.az === 0 && f.dz === 0 && f.dx === 1);
    expect(south).toHaveLength(2);
    const [a, b] = south.sort((p, q) => p.ax - q.ax);
    expect(a!.seam1 && b!.seam0).toBe(true);
    expect(a!.seam0 || b!.seam1).toBe(false);
  });

  it('covers the part of a wall a lower neighbour stands against, and keeps it flush', () => {
    // A 6.6 m annex against the east wall of a 19.8 m block (z 5..15 of its 0..33).
    const faces = facadeFaces(
      mapOf(block(0, 0, 33, 33, 19.8), block(33, 5, 43, 15, 6.6)),
      PALACE_TINT,
    );
    const east = faces.find((f) => f.prism === 0 && f.ax === 33 && f.dz === 1)!;
    expect(east.cover).toHaveLength(1);
    const c = east.cover[0]!;
    expect(c.x0).toBeCloseTo(5, 6);
    expect(c.x1).toBeCloseTo(15, 6);
    expect([c.y0, c.y1]).toEqual([0, 6.6]);
    // Every quad inside the covered rectangle sits on the wall plane (no slot at the annex roof).
    for (const q of allQuads(faceRelief(east))) {
      const inside =
        q.x0 >= c.x0 - 1e-9 && q.x1 <= c.x1 + 1e-9 && q.y0 >= c.y0 - 1e-9 && q.y1 <= c.y1 + 1e-9;
      if (inside && q.axis === 'o') expect(q.o0).toBe(0);
    }
    // No window is cut anywhere in the covered part.
    for (const g of partQuads(faceRelief(east), 'glass')) {
      expect(g.x1 <= c.x0 || g.x0 >= c.x1 || g.y0 >= c.y1).toBe(true);
    }
  });

  it('retains narrow exposed strips between neighbours instead of sampling past them', () => {
    const faces = facadeFaces(
      mapOf(
        block(0, 0, 33, 33, 19.8),
        block(0, -10, 15.45, 0, 19.8),
        block(15.55, -10, 33, 0, 19.8),
      ),
      PALACE_TINT,
    );
    expect(faces.some((f) => f.prism === 0 && f.edge === 0)).toBe(true);
  });
});

describe('faceRelief', () => {
  const faceOf = (len: number, height: number, tint = BLOCK_TINT): FacadeFace =>
    facadeFaces(mapOf(block(0, 0, len, len, height, { tint })), PALACE_TINT)[0]!;

  it.each([
    // bays × storeys of a free-standing block on the bay grid: one window per bay and storey
    // (the crown fits above the top storey's windows).
    [10, 6],
    [5, 6],
    [10, 2],
    [4, 4],
  ])('cuts one window per bay and storey: %i bays × %i storeys', (bays, storeys) => {
    const segs = faceRelief(faceOf(bays * BAY, storeys * STOREY));
    const glass = partQuads(segs, 'glass');
    expect(glass).toHaveLength(bays * storeys);
    for (const g of glass) {
      expect(g.o0).toBe(FACADE_STYLES.block.pane);
      expect(g.x1 - g.x0).toBeCloseTo(WINDOW.s1 - WINDOW.s0, 9);
      expect(g.y1 - g.y0).toBeCloseTo(WINDOW.y1 - WINDOW.y0, 9);
      // On the painted grid: the far LOD shows its window in the same place.
      const inBay = (((g.x0 % BAY) + BAY) % BAY) / BAY;
      expect(inBay).toBeCloseTo(WINDOW.s0 / BAY, 9);
    }
  });

  it('adds pilasters and window hoods on the Palace, and a deeper crown', () => {
    const palace = faceRelief(faceOf(30 * BAY, 12 * STOREY, PALACE_TINT));
    const plain = faceRelief(faceOf(30 * BAY, 12 * STOREY));
    const st = FACADE_STYLES.monumental;
    // Pilaster fronts: tall frame quads on a bay line, standing out of the recessed field.
    const pilasters = fronts(partQuads(palace, 'frame')).filter(
      (q) => q.o0 > st.field && q.y1 - q.y0 > STOREY && q.x1 - q.x0 < 1.3,
    );
    expect(pilasters.length).toBeGreaterThan(6);
    // Centred on a bay line.
    const onGrid = (x: number): boolean => Math.abs(x - Math.round(x / BAY) * BAY) <= 1e-6;
    for (const p of pilasters) {
      expect(onGrid((p.x0 + p.x1) / 2) || onGrid(p.x0) || onGrid(p.x1)).toBe(true);
    }
    const hoods = fronts(partQuads(palace, 'detail')).filter((q) => q.o0 === st.hood!.o);
    expect(hoods.length).toBeGreaterThan(0);
    // Grouped ribs retain the heavy crown with fewer always-on quads than storey bands.
    expect(partQuads(palace, 'frame').length).toBeLessThan(partQuads(plain, 'frame').length);
    const crown = (segs: FaceSegment[]) =>
      new Set(
        partQuads(segs, 'frame')
          .filter((q) => q.y0 >= 12 * STOREY - 1.5)
          .map((q) => q.o0),
      ).size;
    expect(crown(palace)).toBeGreaterThan(crown(plain));
  });

  it('keeps faces too short or too low plain and flush', () => {
    for (const f of [faceOf(1.2, 20), faceOf(20, 2)]) {
      const segs = faceRelief(f);
      for (const q of allQuads(segs)) expect([q.o0, q.o1]).toEqual([0, 0]);
      expect(partQuads(segs, 'glass')).toHaveLength(0);
    }
  });

  it('adds a closed Palace surround profile without moving panes or other LODs', () => {
    const face = faceOf(12 * BAY, 6 * STOREY, PALACE_TINT);
    const before = faceRelief(face, false);
    const after = faceRelief(face);
    for (const part of ['glass', 'frame', 'panel'] as const) {
      expect(partQuads(after, part)).toEqual(partQuads(before, part));
    }
    const detail = partQuads(after, 'detail');
    for (const trim of PALACE_WINDOW_TRIM) {
      expect(detail.some((q) => q.axis === 'o' && q.o0 === trim.offset)).toBe(true);
      expect(
        detail.some((q) => q.axis !== 'o' && (q.o0 === trim.offset || q.o1 === trim.offset)),
      ).toBe(true);
    }
    const blockFace = faceOf(12 * BAY, 6 * STOREY);
    expect(faceRelief(blockFace)).toEqual(faceRelief(blockFace, false));
  });

  it('tiles the whole wall at every level of detail (no holes, no overlaps)', () => {
    for (const tint of [BLOCK_TINT, PALACE_TINT]) {
      const f = faceOf(47.3, 41.7, tint);
      const segs = faceRelief(f);
      const wall = f.len * (f.y1 - f.y0);
      const frame = area(partQuads(segs, 'frame'));
      for (const drawn of [
        frame + area(partQuads(segs, 'panel')),
        frame + area(partQuads(segs, 'detail')) + area(partQuads(segs, 'glass')),
      ]) {
        expect(drawn).toBeCloseTo(wall, 6);
      }
    }
  });

  it('keeps course borders from overlapping the frame at Palace segment joints', () => {
    const faces = [
      faceOf(30 * BAY, 20 * STOREY, PALACE_TINT),
      ...facadeFaces(resolveMap(getMap('defilad'), 'market'), PALACE_TINT).filter(
        (f) => f.style === 'monumental',
      ),
    ];
    let testedBorders = 0;
    const overlaps: string[] = [];
    for (const f of faces) {
      const segs = faceRelief(f);
      const frameByHeight = new Map<string, LocalQuad[]>();
      for (const q of partQuads(segs, 'frame').filter((q) => q.axis === 'y')) {
        testedBorders++;
        const key = q.y0.toFixed(6);
        const bucket = frameByHeight.get(key) ?? [];
        bucket.push(q);
        frameByHeight.set(key, bucket);
      }
      for (const detail of partQuads(segs, 'detail').filter((q) => q.axis === 'y')) {
        for (const frame of frameByHeight.get(detail.y0.toFixed(6)) ?? []) {
          const span = Math.min(frame.x1, detail.x1) - Math.max(frame.x0, detail.x0);
          if (span <= 1e-6) continue;
          const depth = Math.min(frame.o1, detail.o1) - Math.max(frame.o0, detail.o0);
          if (depth > 1e-6) {
            overlaps.push(`prism ${f.prism} edge ${f.edge} y ${detail.y0}`);
          }
        }
      }
    }
    // A non-empty border population prevents a changed fixture from silently passing.
    expect(testedBorders).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
  });

  it('keeps coarse painted panels at the authored field depth', () => {
    const segs = faceRelief(faceOf(40, 30, PALACE_TINT));
    for (const s of segs) {
      for (const q of s.parts.panel) {
        expect([q.axis, q.o0, q.o1]).toEqual([
          'o',
          FACADE_STYLES.monumental.field,
          FACADE_STYLES.monumental.field,
        ]);
      }
    }
  });

  it('never cuts a panel edge through a window keep-out', () => {
    for (const tint of [BLOCK_TINT, PALACE_TINT]) {
      const f = faceOf(52.1, 37.4, tint);
      const k = keepOut(FACADE_STYLES[f.style]);
      for (const p of partQuads(faceRelief(f), 'panel')) {
        for (const x of [p.x0, p.x1]) {
          const u = (((f.sa + x) % BAY) + BAY) % BAY;
          expect(u > k.x0 + 1e-9 && u < k.x1 - 1e-9).toBe(false);
        }
        for (const y of [p.y0, p.y1]) {
          const v = ((y % STOREY) + STOREY) % STOREY;
          expect(v > k.y0 + 1e-9 && v < k.y1 - 1e-9).toBe(false);
        }
      }
    }
  });

  it('keeps corners and roof edges flush with the collision plane', () => {
    for (const tint of [BLOCK_TINT, PALACE_TINT]) {
      const f = faceOf(40, 30, tint);
      for (const q of fronts(allQuads(faceRelief(f)))) {
        if (q.x0 === 0 || q.x1 === f.len || q.y1 === f.y1) expect(q.o0).toBe(0);
      }
    }
  });

  it('splits long, tall faces into LOD segments on bay lines, clear of every window', () => {
    const f = faceOf(30 * BAY, 20 * STOREY);
    const segs = faceRelief(f);
    expect(segs.length).toBeGreaterThan(4);
    for (const s of segs) {
      expect(s.box.x1 - s.box.x0).toBeLessThanOrEqual(6 * BAY + 1 + 1e-9);
      for (const g of s.parts.glass) {
        expect(g.x0 >= s.box.x0 && g.x1 <= s.box.x1).toBe(true);
        expect(g.y0 >= s.box.y0 && g.y1 <= s.box.y1).toBe(true);
      }
    }
  });

  it('keeps the Palace field recessed at horizontal LOD borders without raised seam ridges', () => {
    const segs = faceRelief(faceOf(30 * BAY, 20 * STOREY, PALACE_TINT));
    const boundary = segs.find((s) => s.box.y0 > 1)!.box.y0;
    for (const y of [boundary - 0.001, boundary + 0.001]) {
      const q = fronts([...partQuads(segs, 'frame'), ...partQuads(segs, 'detail')]).find(
        (q) => q.x0 < 11.8 && q.x1 > 11.8 && q.y0 < y && q.y1 > y,
      );
      expect(q, `closed field beside y ${boundary}`).toBeDefined();
      expect(q!.o0).toBe(FACADE_STYLES.monumental.field);
    }
  });

  it('paints only complete geometric windows beside a neighbour or a convex-piece seam', () => {
    const faces = facadeFaces(
      mapOf(block(0, 0, 33, 33, 19.8), block(33, 5, 43, 15, 6.6)),
      PALACE_TINT,
    );
    for (const f of faces) {
      const segs = faceRelief(f);
      let paintedArea = 0;
      for (const p of partQuads(segs, 'panel')) {
        for (let m = Math.floor((f.sa + p.x0) / BAY); m * BAY < f.sa + p.x1; m++) {
          for (let n = Math.floor(p.y0 / STOREY); n * STOREY < p.y1; n++) {
            const width = Math.max(
              0,
              Math.min(p.x1, m * BAY + WINDOW.s1 - f.sa) -
                Math.max(p.x0, m * BAY + WINDOW.s0 - f.sa),
            );
            const height = Math.max(
              0,
              Math.min(p.y1, n * STOREY + WINDOW.y1) - Math.max(p.y0, n * STOREY + WINDOW.y0),
            );
            paintedArea += width * height;
          }
        }
      }
      expect(paintedArea).toBeCloseTo(area(partQuads(segs, 'glass')), 6);
    }
  });
});

describe('facade relief on Plac Defilad', () => {
  const map = placDefilad();

  it('measures Palace surround geometry cost on the actual Market', () => {
    const market = resolveMap(getMap('defilad'), 'market');
    const faces = facadeFaces(market, PALACE_TINT);
    const quads = (trim: boolean) =>
      faces.reduce(
        (total, face) =>
          total +
          faceRelief(face, trim).reduce(
            (n, seg) =>
              n + seg.parts.frame.length + seg.parts.detail.length + seg.parts.glass.length,
            0,
          ),
        0,
      );
    const before = quads(false);
    const after = quads(true);
    const receipt = {
      scope: 'Near-LOD source quads; merged front triangulation measured separately',
      before,
      after,
      ratio: after / before,
      targetMaximumRatio: 1.15,
    };
    const output = new URL(
      '../../../../tools/assets/build/market-window-trim-cost-20261006.json',
      import.meta.url,
    );
    mkdirSync(new URL('.', output), { recursive: true });
    writeFileSync(output, JSON.stringify(receipt, null, 2));
    expect(after / before).toBeLessThanOrEqual(1.15);
  });

  it('stays inside the allowed band behind the collision plane everywhere', () => {
    let quads = 0;
    let deepest = 0;
    let highest = -Infinity;
    const outside: string[] = [];
    for (const f of facadeFaces(map, PALACE_TINT)) {
      for (const q of allQuads(faceRelief(f))) {
        quads++;
        deepest = Math.min(deepest, q.o0, q.o1);
        highest = Math.max(highest, q.o0, q.o1);
        if (q.x0 < -1e-9 || q.x1 > f.len + 1e-9 || q.y0 < f.y0 - 1e-9 || q.y1 > f.y1 + 1e-9) {
          outside.push(`prism ${f.prism} edge ${f.edge}`);
        }
      }
    }
    expect(quads).toBeGreaterThan(10_000);
    expect(deepest).toBeGreaterThanOrEqual(RELIEF_MIN);
    expect(highest).toBeLessThanOrEqual(RELIEF_MAX);
    expect(deepest).toBeCloseTo(-0.3, 9);
    expect(outside).toEqual([]);
  });

  it('is deterministic', () => {
    const digest = (): string => {
      let h = 0;
      let n = 0;
      for (const f of facadeFaces(map, PALACE_TINT)) {
        for (const q of allQuads(faceRelief(f))) {
          for (const v of [q.x0, q.x1, q.y0, q.y1, q.o0, q.o1, q.kind, q.seg, q.sign]) {
            h = (Math.imul(h, 31) + Math.round(v * 1e6)) | 0;
          }
          n++;
        }
      }
      return `${n}:${h}`;
    };
    expect(digest()).toBe(digest());
  });

  it('gives the Palace windows on its setbacks and pilasters up the tower', () => {
    const palace = facadeFaces(map, PALACE_TINT).filter((f) => f.style === 'monumental');
    const tops = new Set(palace.map((f) => f.y1));
    // Every tower tier (62 → 237 m) has an exposed wall of its own with a crown.
    for (const y of [110, 140, 165, 188]) expect(tops.has(y)).toBe(true);
    const glass = palace.flatMap((f) => partQuads(faceRelief(f), 'glass'));
    expect(glass.length).toBeGreaterThan(1000);
  });
});
