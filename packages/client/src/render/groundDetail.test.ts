import * as THREE from 'three';
import { compileFunction } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { getMap, resolveMap, type MapDefinition } from '@wd/shared';
import {
  EDGE_REACH,
  GROUND_DETAIL_SURFACES,
  STONE_CONTACT_ALBEDO,
  addGroundDetail,
  buildGroundMask,
  groundDetail,
  groundNoiseData,
  sampleGroundMask,
  sampleGroundContact,
  setGroundDetailMap,
} from './groundDetail.ts';
import { CONTACT_RANGE, CONTACT_REACH, contactBand, footprintDistance } from './groundContact.ts';
import { addWetness } from './materials.ts';
import { architectureBudget } from './renderBudget.ts';

const empty = (over: Partial<MapDefinition>): MapDefinition => ({
  name: 't',
  bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  boxes: [],
  spawns: [],
  dummies: [],
  ...over,
});

describe('ground edge mask', () => {
  it('resolves a sub-texel contact line at an offset wall and a rotated crate', () => {
    for (const yaw of [0, 37, 90]) {
      const x = 0.137;
      const z = -0.213;
      const a = (yaw * Math.PI) / 180;
      const nx = Math.cos(a);
      const nz = -Math.sin(a);
      const m = buildGroundMask(
        empty({
          boxes: [
            {
              center: { x, y: 1, z },
              size: { x: 2, y: 2, z: 3 },
              mat: 'wood',
              rot: { x: 0, y: yaw, z: 0 },
            },
          ],
        }),
      );
      for (const d of [0.02, 0.07, 0.15, 0.3, 0.6, 0.9]) {
        const actual = sampleGroundContact(m, x + nx * (1 + d), z + nz * (1 + d));
        expect(actual).toBeCloseTo(d, 1);
        expect(contactBand(actual)).toBeCloseTo(contactBand(d), 1);
      }
      expect(m.data.byteLength).toBe(m.textureWidth * m.height * 4);
    }
  });

  it('keeps small trunks and the visible hedge foot in the contact field', () => {
    const m = buildGroundMask(
      empty({
        trees: [{ x: 0.137, z: -0.213, height: 8, crown: 2, kind: 'broadleaf' }],
        foliage: [{ x: 6, z: 0, r: 2, h: 1.5, kind: 'bush' }],
      }),
    );
    expect(sampleGroundContact(m, 0.137 + 0.35 + 0.05, -0.213)).toBeLessThan(0.12);
    expect(sampleGroundContact(m, 6 + 2 * 1.06 + 0.05, 0)).toBeLessThan(0.12);
    expect(contactBand(sampleGroundContact(m, 10, 0))).toBe(0);
  });

  it('does not let neighbouring tangent planes collapse circular contact distances', () => {
    const m = buildGroundMask(
      empty({
        trees: [{ x: 0, z: 0, height: 8, crown: 2, kind: 'broadleaf' }],
      }),
    );
    expect(sampleGroundContact(m, 0.6, 0)).toBeGreaterThan(0.18);
  });

  it('does not extrapolate a box side contact plane past a convex corner', () => {
    const m = buildGroundMask(
      empty({
        boxes: [
          {
            center: { x: 0, y: 1, z: 0 },
            size: { x: 1, y: 2, z: 1 },
            mat: 'wood',
          },
        ],
      }),
    );
    expect(sampleGroundContact(m, 0.51, 0.99)).toBeGreaterThan(0.4);
  });

  it('reconstructs a low kerb line on both sides, even across a mask texel centre', () => {
    const edge = 6.137;
    const m = buildGroundMask(
      empty({
        boxes: [
          {
            center: { x: 0.137, y: 0.075, z: 0 },
            size: { x: 12, y: 0.15, z: 12 },
            mat: 'sidewalk',
          },
        ],
      }),
    );
    for (const d of [-0.3, -0.15, -0.05, 0.05, 0.15, 0.3]) {
      expect(sampleGroundContact(m, edge + d, 0)).toBeCloseTo(Math.abs(d), 1);
    }
    expect(contactBand(sampleGroundContact(m, 0.137, 0))).toBe(0);
  });

  it('decodes a rotated box exactly along its edges and round its corners', () => {
    // A 37° 2 × 3 m box: tangential offsets inside a texel reach √2/2 texel along its edges.
    const yaw = (37 * Math.PI) / 180;
    const m = buildGroundMask(
      empty({
        boxes: [
          {
            center: { x: 0, y: 1, z: 0 },
            size: { x: 2, y: 2, z: 3 },
            rot: { x: 0, y: 37, z: 0 },
            mat: 'wood',
          },
        ],
      }),
    );
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // three's Y rotation: local (x, z) → world (x c + z s, −x s + z c).
    const world = (lx: number, lz: number): [number, number] => [lx * c + lz * s, -lx * s + lz * c];
    const points: Array<{ x: number; z: number; exact: number; fromCorner: number }> = [];
    const add = (lx: number, lz: number): void => {
      const [x, z] = world(lx, lz);
      const ox = Math.max(0, Math.abs(lx) - 1);
      const oz = Math.max(0, Math.abs(lz) - 1.5);
      // How far along its side the point is from the nearest corner (0 in the corner wedge).
      const fromCorner = Math.min(ox > 0 ? 1.5 - Math.abs(lz) : 9, oz > 0 ? 1 - Math.abs(lx) : 9);
      points.push({ x, z, exact: Math.hypot(ox, oz), fromCorner: Math.max(0, fromCorner) });
    };
    for (const gap of [0.02, 0.05, 0.12, 0.3]) {
      for (let t = -1; t <= 1; t += 0.01) {
        add(1 + gap, t * 1.5);
        add(-1 - gap, t * 1.5);
        add(t, 1.5 + gap);
        add(t, -1.5 - gap);
      }
    }
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      for (let a = 0; a <= Math.PI / 2; a += Math.PI / 24) {
        for (const r of [0.05, 0.15, 0.3, 0.5])
          add(sx * (1 + r * Math.cos(a)), sz * (1.5 + r * Math.sin(a)));
      }
    }
    // Judged in contact-band units: what the eye sees (a metre of error far out is invisible).
    let straight = 0;
    let darker = 0;
    let lighter = 0;
    for (const p of points) {
      const d = sampleGroundContact(m, p.x, p.z);
      const err = contactBand(d) - contactBand(p.exact);
      if (p.fromCorner > 0.71) straight = Math.max(straight, Math.abs(d - p.exact));
      darker = Math.max(darker, err);
      lighter = Math.max(lighter, -err);
    }
    expect(points.length).toBeGreaterThan(3000);
    // Straight edges: exact to the quantisation (~1 cm) once a texel holds no corner.
    expect(straight).toBeLessThan(0.015);
    // Corners: both edge lines are stored, so only quantisation remains (no spur, no gap).
    expect(darker).toBeLessThan(0.06);
    expect(lighter).toBeLessThan(0.08);
  });

  it('never draws a contact spur past a neighbour box end in a shared texel', () => {
    const box = (x: number, z: number) => ({
      center: { x, y: 0.5, z },
      size: { x: 1, y: 1, z: 1 },
      mat: 'wood' as const,
    });
    const m = buildGroundMask(empty({ boxes: [box(0, 0), box(1.8, 1.3)] }));
    // True distance 0.483 m (to the first box's corner); an extended edge line read 0.067.
    expect(sampleGroundContact(m, 0.81, 0.87)).toBeGreaterThan(0.45);
  });

  it('never draws a contact spur round a box smaller than a texel', () => {
    const m = buildGroundMask(
      empty({
        boxes: [
          { center: { x: 0.25, y: 0.5, z: 0.25 }, size: { x: 0.06, y: 1, z: 0.06 }, mat: 'wood' },
        ],
      }),
    );
    // 0.21 m beyond its top edge; two stored edge lines read 0.028.
    expect(sampleGroundContact(m, 0.25, 0.49)).toBeGreaterThan(0.2);
  });

  it('keeps tree trunks round: no decagon edge spurs beside the trunk', () => {
    const m = buildGroundMask(
      empty({ trees: [{ x: 0, z: 0, height: 8, crown: 2, kind: 'broadleaf' }] }),
    );
    let worst = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 90) {
      for (const r of [0.4, 0.5, 0.67, 0.8]) {
        const d = sampleGroundContact(m, Math.cos(a) * r, Math.sin(a) * r);
        worst = Math.max(worst, Math.abs(contactBand(d) - contactBand(r - 0.35)));
      }
    }
    // Exact circle: only quantisation (1 cm distance, 1.6 cm radius steps) remains.
    expect(worst).toBeLessThan(0.09);
  });

  it('never lets byte rounding move an acute corner onto clean ground', () => {
    const pts: Array<[number, number]> = [
      [0.1, 0.1],
      [-8.4, 1.8],
      [-8.4, 1.7],
    ];
    const m = buildGroundMask(empty({ prisms: [{ pts, y0: 0, y1: 2, mat: 'concrete' }] }));
    // 0.806 m off the wedge's tip; the rounded edge pair decoded 0.006 (full-strength dirt).
    expect(sampleGroundContact(m, 0.89, -0.06)).toBeGreaterThan(0.75);
  });

  it('never draws a spur over cluttered ground and keeps missing dirt to the format limit', () => {
    type B = { x: number; z: number; sx: number; sz: number; yaw: number };
    const outline = (b: B): Array<[number, number]> => {
      const r = (b.yaw * Math.PI) / 180;
      return [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([u, v]) => {
        const lx = (u! * b.sx) / 2;
        const lz = (v! * b.sz) / 2;
        return [
          b.x + lx * Math.cos(r) + lz * Math.sin(r),
          b.z - lx * Math.sin(r) + lz * Math.cos(r),
        ];
      });
    };
    // Measured over the area every 3 cm in contact-band units against the true distance to all
    // footprints: spurs (darker than rounding explains) are bugs; gaps are where more than two
    // lines matter in one texel (two corners, a slab's end, an acute tip) and only shrink.
    const scene = (boxes: B[], wedges: Array<Array<[number, number]>>, area: number[]) => {
      const m = buildGroundMask(
        empty({
          boxes: boxes.map((b) => ({
            center: { x: b.x, y: 1, z: b.z },
            size: { x: b.sx, y: 2, z: b.sz },
            ...(b.yaw ? { rot: { x: 0, y: b.yaw, z: 0 } } : {}),
            mat: 'wood' as const,
          })),
          prisms: wedges.map((pts) => ({ pts, y0: 0, y1: 2, mat: 'concrete' as const })),
          trees: [{ x: -3.2, z: -3.4, height: 8, crown: 2, kind: 'broadleaf' }],
        }),
      );
      const shapes = [...boxes.map(outline), ...wedges];
      let darker = 0;
      let gaps = 0;
      for (let z = area[2]!; z <= area[3]!; z += 0.03) {
        for (let x = area[0]!; x <= area[1]!; x += 0.03) {
          let t = Math.abs(Math.hypot(x + 3.2, z + 3.4) - 0.35);
          for (const p of shapes) t = Math.min(t, Math.abs(footprintDistance(p, x, z).distance));
          const err = contactBand(sampleGroundContact(m, x, z)) - contactBand(t);
          darker = Math.max(darker, err);
          if (err < -0.3) gaps += 9; // cm² per sample
        }
      }
      return { darker, gaps };
    };
    const clutter = scene(
      [
        { x: 3.1, z: -1.2, sx: 1.2, sz: 1, yaw: 37 },
        { x: 4.3, z: -0.6, sx: 1, sz: 1, yaw: 0 },
        { x: 1.4, z: -2.3, sx: 0.06, sz: 0.06, yaw: 0 },
        { x: -1.6, z: -1.4, sx: 2.5, sz: 0.12, yaw: 12 },
        { x: 0, z: 2, sx: 1, sz: 1, yaw: 0 },
        { x: 1.32, z: 2, sx: 1, sz: 1, yaw: 0 },
      ],
      [
        [
          [5.1, 2.1],
          [9.6, 3.8],
          [9.6, 3.7],
        ],
      ],
      [-5, 10, -5, 5],
    );
    // Two 4 m boxes rotated ±5° with nearly coincident faces (a dropped line left a seam).
    const crossing = scene(
      [
        { x: 0.25, z: 2.35, sx: 4, sz: 4, yaw: 5 },
        { x: 0.3, z: 2.351, sx: 4, sz: 4, yaw: -5 },
      ],
      [],
      [-3, 3.5, -0.6, 5.3],
    );
    for (const r of [clutter, crossing]) expect(r.darker).toBeLessThan(0.09);
    // Round 2 left 8140 / 344 cm² of gaps (and ~1.2 m² of spurs), the radial fallback 5184 / 4184.
    expect(clutter.gaps).toBeLessThan(4700);
    expect(crossing.gaps).toBeLessThan(3500);
  });

  it('draws no spur between probes when three rotated boxes share a texel', () => {
    // Codex repro: (x, z, width, depth, yaw); 0.142 m from the nearest box, an extrapolated
    // edge read 0.054 (full-strength dirt) while every probe passed.
    const m = buildGroundMask(
      empty({
        boxes: [
          [0.67, 0.61, 1.78, 0.22, -7],
          [-0.84, -0.15, 2.62, 1.14, 10],
          [0.89, 0.95, 1.07, 1.51, 109],
        ].map(([x, z, w, d, yaw]) => ({
          center: { x: x!, y: 1, z: z! },
          size: { x: w!, y: 2, z: d! },
          rot: { x: 0, y: yaw!, z: 0 },
          mat: 'wood' as const,
        })),
      }),
    );
    expect(sampleGroundContact(m, 0.625, 0.325)).toBeGreaterThan(0.13);
  });

  it('checks a proven corner pair on its rounded bytes near the conditioning limit', () => {
    // Codex repro: a ~34° wedge; the proven pair's bytes read 0.1604 m where it is 0.1803 m.
    const pts: Array<[number, number]> = [
      [0, 0],
      [-3, 0],
      [0, -2],
    ];
    const m = buildGroundMask(empty({ prisms: [{ pts, y0: 0, y1: 2, mat: 'concrete' }] }));
    const d = sampleGroundContact(m, -3.15, 0.1);
    expect(contactBand(d) - contactBand(0.1803)).toBeLessThan(0.08);
  });

  it('keeps acute corners spur-free between the probes too', () => {
    // Codex repro: a ~34° tip; rounded normals read 0.1394 m at a non-probe point (0.1577 true).
    const pts: Array<[number, number]> = [
      [0.009, -0.113],
      [-0.463, -7.415],
      [3.688, -6.437],
    ];
    const m = buildGroundMask(empty({ prisms: [{ pts, y0: 0, y1: 2, mat: 'concrete' }] }));
    let worst = 0;
    for (let z = -0.5; z <= 0.5; z += 0.01) {
      for (let x = -0.5; x <= 0.5; x += 0.01) {
        const t = Math.abs(footprintDistance(pts, x, z).distance);
        worst = Math.max(worst, contactBand(sampleGroundContact(m, x, z)) - contactBand(t));
      }
    }
    expect(worst).toBeLessThan(0.08);
  });

  it('keeps the nearest contact plane when competing footprints share a texel', () => {
    const m = buildGroundMask(
      empty({
        boxes: [
          {
            center: { x: 0, y: 1, z: 0 },
            size: { x: 1, y: 2, z: 2 },
            mat: 'wood',
          },
          {
            center: { x: 1.32, y: 1, z: 0 },
            size: { x: 1, y: 2, z: 2 },
            mat: 'wood',
          },
        ],
      }),
    );
    for (const x of [0.51, 0.56, 0.61, 0.66, 0.71, 0.76, 0.81]) {
      const expected = Math.min(x - 0.5, 0.82 - x);
      const d = sampleGroundContact(m, x, 0);
      expect(d).toBeCloseTo(expected, 1);
      expect(Math.abs(contactBand(d) - contactBand(expected))).toBeLessThan(0.06);
    }
  });

  it('preserves the reported Market pallet contact at 112, -48.49', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const m = buildGroundMask(map);
    const nearby = map.boxes.filter((b) => {
      const dx = b.center.x - 112;
      const dz = b.center.z - -48.49;
      return Math.hypot(dx, dz) < 2.5 && b.visible !== false;
    });
    const candidates = nearby
      .map((box) => {
        const single = buildGroundMask({
          ...map,
          boxes: [box],
          prisms: [],
          trees: [],
          foliage: [],
        });
        return { box, d: sampleGroundContact(single, 112, -48.49) };
      })
      .filter((c) => c.d < CONTACT_RANGE)
      .sort((a, b) => a.d - b.d);
    const isolatedD = candidates[0]!.d;
    const withNeighbour = buildGroundMask({
      ...map,
      boxes: [candidates[0]!.box, candidates[1]!.box],
      prisms: [],
      trees: [],
      foliage: [],
    });
    const neighbourD = sampleGroundContact(withNeighbour, 112, -48.49);
    const d = sampleGroundContact(m, 112, -48.49);
    expect(nearby.length).toBeGreaterThan(1);
    expect(candidates.length).toBeGreaterThan(1);
    expect(isolatedD).toBeGreaterThanOrEqual(0);
    expect(isolatedD).toBeLessThan(0.03);
    expect(neighbourD).toBeCloseTo(isolatedD, 2);
    expect(d).toBeCloseTo(isolatedD, 2);
    expect(Math.abs(contactBand(neighbourD) - contactBand(isolatedD))).toBeLessThan(0.02);
    expect(Math.abs(contactBand(d) - contactBand(isolatedD))).toBeLessThan(0.02);
  });

  it('is dirty against a wall, fading to clean by EDGE_REACH, and flags the inside', () => {
    const map = empty({
      boxes: [{ center: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' }],
    });
    const m = buildGroundMask(map);
    expect(sampleGroundMask(m, 0, 0)).toEqual([1, 1]);
    const [nearWall] = sampleGroundMask(m, 1.3, 0);
    const [mid] = sampleGroundMask(m, 2.2, 0);
    const [far] = sampleGroundMask(m, 1 + EDGE_REACH + 1, 0);
    expect(nearWall).toBeGreaterThan(0.7);
    expect(mid).toBeLessThan(nearWall);
    expect(mid).toBeGreaterThan(0.2);
    expect(far).toBe(0);
    expect(sampleGroundMask(m, 1.3, 0)[1]).toBe(0);
  });

  it('ignores invisible walls and things off the ground', () => {
    const map = empty({
      boxes: [
        {
          center: { x: 0, y: 0, z: 0 },
          size: { x: 40, y: 20, z: 40 },
          mat: 'concrete',
          visible: false,
        },
        { center: { x: 5, y: 3, z: 5 }, size: { x: 1, y: 0.2, z: 1 }, mat: 'metal' }, // a sign
      ],
    });
    const m = buildGroundMask(map);
    expect(sampleGroundMask(m, 0, 0)[0]).toBe(0);
    expect(sampleGroundMask(m, 5, 5)[0]).toBe(0);
  });

  it('marks a low kerb prism by its outline only (its top is walkable ground)', () => {
    const pts = [
      [-6, -6],
      [6, -6],
      [6, 6],
      [-6, 6],
    ] as const;
    const m = buildGroundMask(
      empty({ prisms: [{ pts: [...pts], y0: 0, y1: 0.15, mat: 'concrete' }] }),
    );
    expect(sampleGroundMask(m, 6, 0)[0]).toBe(1);
    expect(sampleGroundMask(m, 0, 0)).toEqual([0, 0]);
  });

  it('marks a low walkable box (a 15 cm sidewalk) by its outline only, a tall box solid', () => {
    const low = buildGroundMask(
      empty({
        boxes: [
          { center: { x: 0, y: 0.075, z: 0 }, size: { x: 12, y: 0.15, z: 12 }, mat: 'sidewalk' },
        ],
      }),
    );
    expect(sampleGroundMask(low, 6, 0)[0]).toBe(1); // the kerb edge collects grime
    expect(sampleGroundMask(low, 0, 0)).toEqual([0, 0]); // the pavement itself is open ground
    const wall = buildGroundMask(
      empty({
        boxes: [{ center: { x: 0, y: 1, z: 0 }, size: { x: 12, y: 2, z: 12 }, mat: 'concrete' }],
      }),
    );
    expect(sampleGroundMask(wall, 0, 0)[1]).toBe(1); // a solid block's inside is flagged
  });

  it('covers the real Market (walls, trees and hedges leave grime; open square stays clean)', () => {
    const map = resolveMap(getMap('defilad'), 'market');
    const m = buildGroundMask(map);
    expect(m.width * m.height).toBeLessThan(1500 * 1500);
    let dirty = 0;
    for (let k = 0; k < m.width * m.height; k++) if (m.data[k * 4]! > 0) dirty++;
    const share = dirty / (m.width * m.height);
    // Grime is a band along edges, not the whole square.
    expect(share).toBeGreaterThan(0.1);
    expect(share).toBeLessThan(0.8);
    const b = map.bounds;
    const bush = map.foliage!.find(
      (f) =>
        f.kind === 'bush' &&
        (f.y ?? 0) < 0.3 &&
        f.x > b.minX &&
        f.x < b.maxX &&
        f.z > b.minZ &&
        f.z < b.maxZ,
    )!;
    expect(sampleGroundMask(m, bush.x, bush.z)[0]).toBe(1);
  });
});

describe('ground detail material', () => {
  for (const wallX of [0.49, 0.01, 0.137, 0.25, 0.37, -0.137, -0.49]) {
    it(`keeps wear continuous across mask texels beside a wall at x=${wallX}`, () => {
      const mat = new THREE.MeshStandardMaterial();
      addGroundDetail(mat, true);
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      } as unknown as THREE.WebGLProgramParametersWithUniforms;
      mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      // Evaluate the emitted scalar expression so the regression follows the real shader.
      const expression = shader.fragmentShader.match(/gdWear = (0\.09[^;]+);/);
      expect(expression).not.toBeNull();
      const evaluate = compileFunction(
        `const broad = { g: 1 }, fade = 1, gdStone = 1; return ${expression![1]};`,
        ['contactDistance', 'edge', 'smoothstep'],
      ) as (
        distance: number,
        edge: number,
        smoothstep: (a: number, b: number, x: number) => number,
      ) => number;
      const wear = (d: number): number =>
        evaluate(d, contactBand(d), (a, b, x) => THREE.MathUtils.smoothstep(x, a, b));
      const m = buildGroundMask(
        empty({
          boxes: [
            {
              center: { x: wallX - 1, y: 1, z: 0 },
              size: { x: 2, y: 2, z: 6 },
              mat: 'concrete',
            },
          ],
        }),
      );
      // Odd millimetres straddle every 0.5 m boundary, including the 1.499/1.501 repro.
      let previous = wear(sampleGroundContact(m, -0.499, 0));
      let maxStep = 0;
      let peak = 0;
      for (let i = 1; i <= 1250; i++) {
        const current = wear(sampleGroundContact(m, -0.499 + i * 0.002, 0));
        maxStep = Math.max(maxStep, Math.abs(current - previous));
        peak = Math.max(peak, current);
        previous = current;
      }
      expect(maxStep).toBeLessThan(0.002);
      expect(peak).toBeGreaterThan(0.08); // Preserve visible wear rather than disabling it.
      expect(wear(CONTACT_REACH)).toBe(0);
      expect(wear(CONTACT_RANGE)).toBe(0);
      mat.dispose();
    });
  }

  it('tiles its noise seamlessly (edge texels continue across the wrap)', () => {
    const n = groundNoiseData(64);
    let jump = 0;
    let step = 0;
    for (let y = 0; y < 64; y++) {
      const row = (x: number): number => n[(y * 64 + x) * 4]!;
      jump += Math.abs(row(63) - row(0));
      step += Math.abs(row(32) - row(31));
    }
    expect(jump).toBeLessThan(step * 2 + 64);
  });

  it('chains after the wetness hook and binds the shared samplers', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWetness(mat);
    addGroundDetail(mat, true);
    expect(mat.customProgramCacheKey()).toBe('wet|ground-v3');
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.uWetness).toBeDefined();
    expect(shader.uniforms.uGdMask).toBe(groundDetail.mask);
    expect(shader.uniforms.uGdNoise).toBe(groundDetail.noise);
    expect(shader.uniforms.uGdStone).toEqual({ value: 1 });
    expect(shader.fragmentShader).toContain('groundDetail( diffuseColor.rgb');
    expect(shader.fragmentShader).toContain('gdPuddle');
    expect(shader.vertexShader).toContain('vGdPos =');
    // The detail runs before lighting reads roughness (and after the wetness hook).
    const fs = shader.fragmentShader;
    // Puddles fill only where the wetness hook found rain (wetExposed) and ripple with the rain clock.
    expect(shader.uniforms.uRainTime).toBeDefined();
    expect(shader.uniforms.uArchitectureBudget).toBe(architectureBudget);
    expect(shader.uniforms.uRainOcc).toBeDefined();
    expect(fs.indexOf('gdPuddle * wetExposed')).toBeGreaterThan(fs.indexOf('uWetness > 0.0'));
    expect(fs).toContain('gdRipples( vGdPos.xz, uRainTime )');
    // Ripple normals are Medium+ only; they stop spawning after the rain stops.
    expect(fs.indexOf('#ifndef TONE_MAPPING')).toBeLessThan(
      fs.indexOf('gdRipples( vGdPos.xz, uRainTime )'),
    );
    expect(fs).toContain('> uRainStop ) continue;');
    expect(shader.uniforms.uRainStop).toBeDefined();
    expect(fs.indexOf('gdPuddle * wetExposed')).toBeLessThan(
      fs.indexOf('#include <lights_physical_fragment>'),
    );
    expect(fs).toContain('gdContactDistance( xz, m )');
    expect(fs).toContain('uniform float uGdStone;');
    expect(fs).toContain('mix( asphaltDetail, stoneDetail, uGdStone )');
    expect(fs).toContain(`vec3( ${STONE_CONTACT_ALBEDO} )`);
    expect(fs).toContain(
      'gdCornerDistance( gdContactLine( o, maskSample.ba, n0 ), gdContactLine( o, second, n1 ), dot( n0, n1 ) )',
    );
    expect(fs).toContain('abs( length( o + n * toCentre ) - r )');
    expect(fs).toContain('mix( 0.5, 0.0, uGdStone ) * stain');
    expect(fs).toContain('( 1.0 - uGdStone ) * ( 0.14 * basin + 0.2 * tide )');
    expect(fs).toContain(
      'roughnessFactor = mix( roughnessFactor, clamp( roughnessFactor - gdWear * faceWear, 0.72, 0.98 ), gdStone );',
    );
    expect(fs.indexOf('clamp( roughnessFactor - gdWear')).toBeLessThan(
      fs.indexOf('float gdWater = smoothstep'),
    );
    expect(fs).not.toContain('gdMaskAt( xz )');
    const mediumGuard = fs.indexOf('if ( uArchitectureBudget > 0.5 ) return mix');
    expect(fs.indexOf('float contactDistance = gdContactDistance( xz, m );')).toBeLessThan(
      mediumGuard,
    );
    expect(fs.indexOf('vec4 broad = texture2D')).toBeLessThan(mediumGuard);
    expect(mediumGuard).toBeLessThan(fs.indexOf('vec4 mid = texture2D'));
    expect(fs.indexOf('gdWear = 0.09')).toBeLessThan(mediumGuard);
    expect(fs).toContain('smoothstep( 0.45, 0.7, contactDistance )');
    expect(fs).toContain(`1.0 - smoothstep( 0.7, ${CONTACT_REACH}, contactDistance )`);
    // Street stone only, even beyond the detail fade; underground floors and vertical faces
    // keep their lighting. The sky correction precedes AO and the later lamp/neon bakes.
    expect(fs.indexOf('vGdPos.y < -0.4 ) return albedo')).toBeLessThan(
      fs.indexOf('gdStone = uGdStone;'),
    );
    expect(fs.indexOf('gdStone = uGdStone;')).toBeLessThan(fs.indexOf('if ( fade <= 0.0 )'));
    const fill = fs.indexOf('irradiance = gdStoneFill');
    expect(fill).toBeGreaterThan(fs.indexOf('#include <lights_fragment_maps>'));
    expect(fill).toBeLessThan(fs.indexOf('#include <lights_fragment_end>'));
    expect(fill).toBeLessThan(fs.indexOf('#include <aomap_fragment>'));
    expect(fs).toContain('iblIrradiance = gdStoneFill');
    expect(fs).toContain('gdStone * ( 1.0 - uWetness * wetExposed )');
    expect(fs).not.toContain('\n          radiance = gdStoneFill'); // retain the sky reflection lobe
    expect(fs).not.toContain('reflectedLight.directDiffuse =');
  });

  it('keeps the same material program when map uniforms and tiers change', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWetness(mat);
    addGroundDetail(mat, true);
    const key = mat.customProgramCacheKey();
    const version = mat.version;
    for (const tier of [0, 1, 0]) {
      architectureBudget.value = tier;
      setGroundDetailMap(empty({}));
      expect(mat.customProgramCacheKey()).toBe(key);
      expect(mat.version).toBe(version);
      expect(groundDetail.mask.value.format).toBe(THREE.RGBAFormat);
    }
    const asphalt = new THREE.MeshStandardMaterial();
    addWetness(asphalt);
    addGroundDetail(asphalt, false);
    expect(asphalt.customProgramCacheKey()).toBe(key);
  });

  it('keeps stone contact darkening in the requested dry albedo range', () => {
    const coreScale = 1 - contactBand(0) * (1 - STONE_CONTACT_ALBEDO);
    const eightCentimetreScale = 1 - contactBand(0.08) * (1 - STONE_CONTACT_ALBEDO);
    expect(coreScale).toBeGreaterThanOrEqual(0.62);
    expect(coreScale).toBeLessThanOrEqual(0.67);
    expect(eightCentimetreScale).toBeGreaterThanOrEqual(0.62);
    expect(eightCentimetreScale).toBeLessThanOrEqual(0.67);
  });

  it('fills the mask sampler in place of the 1×1 default (same uniform object)', () => {
    const uniform = groundDetail.mask;
    const m = setGroundDetailMap(
      empty({
        boxes: [{ center: { x: 0, y: 1, z: 0 }, size: { x: 2, y: 2, z: 2 }, mat: 'concrete' }],
      }),
    );
    expect(groundDetail.mask).toBe(uniform);
    expect(uniform.value.image.width).toBe(m.textureWidth);
    expect(uniform.value.unpackAlignment).toBe(1);
    const r = groundDetail.rect.value;
    expect(r.x + 1 / r.z).toBeCloseTo(m.minX + m.width * m.texel);
  });

  it('only ground surfaces get it', () => {
    expect([...GROUND_DETAIL_SURFACES].sort()).toEqual(['asphalt', 'paving', 'sidewalk']);
  });
});
