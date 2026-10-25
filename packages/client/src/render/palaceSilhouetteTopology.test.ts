import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap, PALACE_TINT, resolveMap, placDefilad, type MapDefinition } from '@wd/shared';
import { facadeFaces } from './facadeRelief.ts';
import {
  palaceCrowns,
  palaceCrownGeometry,
  palaceClockGeometry,
  palaceSpireGeometry,
  PALACE_ATTIC_MIN_RUN,
  type PalaceStoneGeometry,
} from './palaceSilhouette.ts';

const market = resolveMap(getMap('defilad'), 'market');
const crownsFor = (map: MapDefinition) =>
  palaceCrowns(facadeFaces(map, PALACE_TINT), map.prisms ?? []);
type Xz = readonly [number, number];
const cross = (a: Xz, b: Xz, c: Xz): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Independent convex-polygon intersection oracle for coplanar top triangles. */
function overlapArea(a: readonly Xz[], b: readonly Xz[]): number {
  let polygon = [...a];
  const sign = Math.sign(cross(b[0]!, b[1]!, b[2]!));
  for (let i = 0; i < b.length && polygon.length; i++) {
    const p = b[i]!;
    const q = b[(i + 1) % b.length]!;
    const input = polygon;
    polygon = [];
    for (let j = 0; j < input.length; j++) {
      const start = input[j]!;
      const end = input[(j + 1) % input.length]!;
      const d0 = sign * cross(p, q, start);
      const d1 = sign * cross(p, q, end);
      if (d0 >= 0) polygon.push(start);
      if (d0 < 0 !== d1 < 0) {
        const t = d0 / (d0 - d1);
        polygon.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
      }
    }
  }
  return Math.abs(
    polygon.reduce((area, p, i) => {
      const q = polygon[(i + 1) % polygon.length]!;
      return area + p[0] * q[1] - p[1] * q[0];
    }, 0) / 2,
  );
}

function checkTopOverlap(geometries: readonly PalaceStoneGeometry[]): void {
  const levels = new Map<
    number,
    { points: Xz[]; x0: number; x1: number; z0: number; z1: number }[]
  >();
  for (const g of geometries) {
    for (let i = 0; i < g.idx.length; i += 3) {
      const ids = g.idx.slice(i, i + 3);
      const y = g.pos[ids[0]! * 3 + 1]!;
      if (g.nrm[ids[0]! * 3 + 1]! < 0.999999) continue;
      expect(ids.every((id) => Math.abs(g.pos[id * 3 + 1]! - y) < 1e-8)).toBe(true);
      const points = ids.map((id): Xz => [g.pos[id * 3]!, g.pos[id * 3 + 2]!]);
      const list = levels.get(y) ?? [];
      list.push({
        points,
        x0: Math.min(...points.map((p) => p[0])),
        x1: Math.max(...points.map((p) => p[0])),
        z0: Math.min(...points.map((p) => p[1])),
        z1: Math.max(...points.map((p) => p[1])),
      });
      levels.set(y, list);
    }
  }
  for (const [y, triangles] of levels) {
    triangles.sort((a, b) => a.x0 - b.x0);
    for (let i = 0; i < triangles.length; i++) {
      const a = triangles[i]!;
      for (let j = i + 1; j < triangles.length; j++) {
        const b = triangles[j]!;
        if (b.x0 >= a.x1 - 1e-8) break;
        if (b.x1 <= a.x0 + 1e-8 || b.z0 >= a.z1 - 1e-8 || b.z1 <= a.z0 + 1e-8) continue;
        expect(
          overlapArea(a.points, b.points),
          `coplanar tops at ${y}: ${JSON.stringify([a.points, b.points])}`,
        ).toBeLessThan(1e-8);
      }
    }
  }
}

describe('Palace roof topology regressions', () => {
  it('does not crown any equal-height shared roof edge, including thin convex fragments', () => {
    const thin: MapDefinition = {
      ...market,
      boxes: [],
      prisms: [
        {
          pts: [
            [0, 0],
            [12.8, 0],
            [12.8, 8],
            [0, 8],
          ],
          y0: 0,
          y1: 16,
          mat: 'facade',
          tint: PALACE_TINT,
        },
        {
          pts: [
            [0, -0.02],
            [12.8, -0.02],
            [12.8, 0],
            [0, 0],
          ],
          y0: 0,
          y1: 16,
          mat: 'facade',
          tint: PALACE_TINT,
        },
      ],
    };
    for (const map of [thin, market]) {
      const crowns = crownsFor(map);
      let sharedRoofEdges = 0;
      // Inspect raw roof edges, independently of the wall's 5 cm cover mask.
      for (const [pi, p] of (map.prisms ?? []).entries()) {
        if (p.visible === false || p.tint !== PALACE_TINT) continue;
        for (const [qi, q] of (map.prisms ?? []).entries()) {
          if (qi === pi || q.visible === false || q.tint !== PALACE_TINT || q.y1 !== p.y1) continue;
          for (let i = 0; i < p.pts.length; i++) {
            const a = p.pts[i]!;
            const b = p.pts[(i + 1) % p.pts.length]!;
            for (let j = 0; j < q.pts.length; j++) {
              const c = q.pts[j]!;
              const d = q.pts[(j + 1) % q.pts.length]!;
              if (
                Math.hypot(a[0] - d[0], a[1] - d[1]) < 1e-7 &&
                Math.hypot(b[0] - c[0], b[1] - c[1]) < 1e-7
              )
                sharedRoofEdges++;
            }
          }
        }
      }
      for (const c of crowns) {
        const f = c.face;
        for (const [pi, p] of (map.prisms ?? []).entries()) {
          if (p.visible === false || p.y1 !== f.y1 || c.sources.some((s) => s.prism === pi))
            continue;
          for (let i = 0; i < p.pts.length; i++) {
            const a = p.pts[i]!;
            const b = p.pts[(i + 1) % p.pts.length]!;
            const opposite = (b[0] - a[0]) * f.dx + (b[1] - a[1]) * f.dz < 0;
            const onLine = [a, b].every(
              (point) => Math.abs((point[0] - f.ax) * f.dz - (point[1] - f.az) * f.dx) < 1e-7,
            );
            if (!opposite || !onLine) continue;
            const ends = [a, b].map((point) => (point[0] - f.ax) * f.dx + (point[1] - f.az) * f.dz);
            const overlap = Math.min(c.s1, Math.max(...ends)) - Math.max(c.s0, Math.min(...ends));
            expect(
              overlap,
              `equal roof seam: crown prism ${f.prism}, neighbour ${pi}`,
            ).toBeLessThanOrEqual(1e-5);
          }
        }
      }
      expect(sharedRoofEdges).toBeGreaterThan(0);
    }
    expect(crownsFor(thin).some((c) => c.sources.some((f) => f.prism === 0 && f.edge === 0))).toBe(
      false,
    );
    const lower = { ...thin, prisms: thin.prisms!.map((p, i) => (i === 1 ? { ...p, y1: 12 } : p)) };
    expect(crownsFor(lower).some((c) => c.sources.some((f) => f.prism === 0 && f.edge === 0))).toBe(
      true,
    );
    const taller = {
      ...thin,
      prisms: thin.prisms!.map((p, i) => (i === 1 ? { ...p, y1: 18 } : p)),
    };
    expect(
      crownsFor(taller).some((c) => c.sources.some((f) => f.prism === 0 && f.edge === 0)),
    ).toBe(false);
    const invisible = {
      ...thin,
      prisms: thin.prisms!.map((p, i) => (i === 1 ? { ...p, visible: false } : p)),
    };
    expect(
      crownsFor(invisible).some((c) => c.sources.some((f) => f.prism === 0 && f.edge === 0)),
    ).toBe(true);

    const partial = {
      ...thin,
      prisms: [
        thin.prisms![0]!,
        {
          ...thin.prisms![1]!,
          pts: [
            [3.2, -0.02],
            [9.6, -0.02],
            [9.6, 0],
            [3.2, 0],
          ] as [number, number][],
        },
      ],
    };
    const intervals = crownsFor(partial)
      .filter((c) => c.sources.some((f) => f.prism === 0 && f.edge === 0))
      .map((c) => [c.face.ax + c.s0, c.face.ax + c.s1]);
    expect(intervals).toHaveLength(2);
    expect(intervals[0]![0]).toBeCloseTo(0, 7);
    expect(intervals[0]![1]).toBeCloseTo(3.2, 7);
    expect(intervals[1]![0]).toBeCloseTo(9.6, 7);
    expect(intervals[1]![1]).toBeCloseTo(12.8, 7);
  });

  it('gives every crown, clock and spire triangle nonzero metre-density UVs on its surface plane', () => {
    const faces = facadeFaces(market, PALACE_TINT);
    const geometries = [
      ...crownsFor(market).flatMap((c) => Object.values(palaceCrownGeometry(c))),
      ...palaceClockGeometry(faces),
      palaceSpireGeometry(faces)!,
    ];
    for (const g of geometries) {
      for (let i = 0; i < g.idx.length; i += 3) {
        const ids = g.idx.slice(i, i + 3);
        const p = ids.map((id) => g.pos.slice(id * 3, id * 3 + 3));
        const uv = ids.map((id): Xz => [g.uv[id * 2]!, g.uv[id * 2 + 1]!]);
        const u = p[1]!.map((v, j) => v - p[0]![j]!);
        const v = p[2]!.map((value, j) => value - p[0]![j]!);
        const worldArea = Math.hypot(
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        );
        const uvArea = Math.abs(cross(uv[0]!, uv[1]!, uv[2]!));
        expect(uvArea).toBeGreaterThan(0);
        // The wall maps one UV unit to one metre; bound area and all edge densities.
        const density = Math.sqrt(uvArea / worldArea);
        expect(density).toBeGreaterThanOrEqual(0.5);
        expect(density).toBeLessThanOrEqual(2);
        for (let j = 0; j < 3; j++) {
          const k = (j + 1) % 3;
          const metres = Math.hypot(...p[j]!.map((value, axis) => value - p[k]![axis]!));
          const edgeDensity = Math.hypot(uv[j]![0] - uv[k]![0], uv[j]![1] - uv[k]![1]) / metres;
          expect(edgeDensity).toBeGreaterThanOrEqual(0.5 - 1e-8);
          expect(edgeDensity).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('emits each upward-facing cornice and attic surface once across all Market corners', () => {
    const geometries = crownsFor(market).flatMap((c) => Object.values(palaceCrownGeometry(c)));
    checkTopOverlap(geometries);
  });

  it('fully covers convex cornice corners with no missing top faces', () => {
    const square: MapDefinition = {
      ...market,
      prisms: [
        {
          pts: [
            [0, 0],
            [12, 0],
            [12, 12],
            [0, 12],
          ],
          y0: 0,
          y1: 16,
          mat: 'facade',
          tint: PALACE_TINT,
        },
      ],
    };
    const geometries = crownsFor(square).map((c) => palaceCrownGeometry(c).frame);
    let topArea = 0;
    for (const g of geometries) {
      for (let i = 0; i < g.idx.length; i += 3) {
        const ids = g.idx.slice(i, i + 3);
        if (g.nrm[ids[0]! * 3 + 1]! < 0.999999) continue;
        if (!ids.every((id) => Math.abs(g.pos[id * 3 + 1]! - 16.18) < 1e-8)) continue;
        const points = ids.map((id): Xz => [g.pos[id * 3]!, g.pos[id * 3 + 2]!]);
        topArea += Math.abs(cross(points[0]!, points[1]!, points[2]!)) / 2;
      }
    }
    // Outer overhang = 4 cm; inner edge = 90 cm from every roof boundary.
    expect(topArea).toBeCloseTo((12 + 2 * 0.04) ** 2 - (12 - 2 * 0.9) ** 2, 7);
    checkTopOverlap(geometries);
  });

  it('closes each near-only moulding end when the adjoining run drops to far LOD', () => {
    const longRoof: MapDefinition = {
      ...market,
      prisms: [
        {
          pts: [
            [0, 0],
            [72, 0],
            [72, 12],
            [0, 12],
          ],
          y0: 0,
          y1: 16,
          mat: 'facade',
          tint: PALACE_TINT,
        },
      ],
    };
    const crowns = crownsFor(longRoof);
    expect(crowns.some((c) => !c.corner0 && !c.corner1)).toBe(true);
    for (const c of crowns) {
      // The neighbour contributes only its frame at mid/far, so this detail must close itself.
      const { detail: g } = palaceCrownGeometry(c);
      for (const [s, miter, sign] of [
        [c.s0 + 0.01, c.miter0 ?? 0, -1],
        [c.s1 - 0.01, c.miter1 ?? 0, 1],
      ] as const) {
        let cap = false;
        for (let i = 0; i < g.idx.length; i += 3) {
          const ids = g.idx.slice(i, i + 3);
          const n = ids[0]! * 3;
          if ((g.nrm[n]! * c.face.dx + g.nrm[n + 2]! * c.face.dz) * sign < 0.5) continue;
          cap ||= ids.every((id) => {
            const x = g.pos[id * 3]! - c.face.ax;
            const z = g.pos[id * 3 + 2]! - c.face.az;
            const along = x * c.face.dx + z * c.face.dz;
            const depth = x * c.face.dz - z * c.face.dx;
            return Math.abs(along - s - miter * depth) < 1e-7;
          });
        }
        expect(cap, `moulding run ${c.s0}-${c.s1}, cap at ${s}`).toBe(true);
      }
    }
  });

  it.each(['near', 'mid', 'far'] as const)(
    'closes every shipped short/full crown joint at %s LOD',
    (lod) => {
      for (const map of [placDefilad(), market]) {
        const crowns = crownsFor(map);
        const endpoint = (c: (typeof crowns)[number], s: number): THREE.Vector3 =>
          new THREE.Vector3(c.face.ax + c.face.dx * s, c.face.y1, c.face.az + c.face.dz * s);
        const joins = crowns
          .filter((c) => c.face.len < PALACE_ATTIC_MIN_RUN)
          .flatMap((short) =>
            ([0, 1] as const).flatMap((end) => {
              const s = end === 0 ? short.s0 : short.s1;
              const point = endpoint(short, s);
              const full = crowns.find(
                (c) =>
                  c.face.len >= PALACE_ATTIC_MIN_RUN &&
                  (end === 0 ? c.corner1 : c.corner0) &&
                  endpoint(c, end === 0 ? c.s1 : c.s0).distanceTo(point) < 1e-5,
              );
              return full ? [{ short, full, end, s }] : [];
            }),
          );
        expect(joins.length).toBeGreaterThan(0);
        expect(joins.some(({ short }) => short.face.y1 === 34)).toBe(true);
        expect(
          joins.some(
            ({ short, full }) =>
              short.face.prism === 1324 && short.face.edge === 0 && full.face.edge === 3,
          ),
        ).toBe(true);
        const material = new THREE.MeshBasicMaterial();
        const meshes = crowns.flatMap((c) => {
          const { frame, detail } = palaceCrownGeometry(c);
          return (lod === 'near' ? [frame, detail] : [frame]).map((g) => {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
            geometry.setIndex(g.idx);
            return new THREE.Mesh(geometry, material);
          });
        });
        for (const { short, full, end, s } of joins) {
          const f = short.face;
          const m = (end === 0 ? short.miter0 : short.miter1) ?? 0;
          const corner = endpoint(short, s);
          const band = (f.y1 < 62 ? 1.35 : f.y1 <= 188 ? 2.1 : 1.25) * 0.55;
          const normal = new THREE.Vector3(f.dx - m * f.dz, 0, f.dz + m * f.dx).normalize();
          let probes = 0;
          // Independently sample every depth region of the triangular and stepped profiles.
          for (const depth of [-0.85, -0.6, -0.4, -0.1, -0.06, -0.015, 0.025]) {
            const point = new THREE.Vector3(
              corner.x + (f.dx * m + f.dz) * depth,
              f.y1,
              corner.z + (f.dz * m - f.dx) * depth,
            );
            // Skip depths pinched off by the other end of a narrow connector or neighbour.
            if (
              [short, full].some((c) => {
                const dx = point.x - c.face.ax;
                const dz = point.z - c.face.az;
                const along = dx * c.face.dx + dz * c.face.dz;
                const o = dx * c.face.dz - dz * c.face.dx;
                return (
                  along < c.s0 + (c.miter0 ?? 0) * o - 1e-5 ||
                  along > c.s1 + (c.miter1 ?? 0) * o + 1e-5
                );
              })
            )
              continue;
            const shortTop = depth < -0.65 ? 0 : (band * (depth + 0.65)) / 0.69;
            const fullTop = depth >= -0.65 && depth <= -0.08 ? band : 0.18;
            for (const fraction of [0.25, 0.5, 0.75]) {
              point.y =
                f.y1 + Math.min(shortTop, fullTop) + Math.abs(shortTop - fullTop) * fraction;
              // Enter the taller profile from the shorter one's side; front-face rays also
              // catch reversed transition winding. Keep the ray local to the joint (8 mm).
              const sign = (end === 0 ? 1 : -1) * (fullTop > shortTop ? 1 : -1);
              const ray = new THREE.Raycaster(
                point.clone().addScaledVector(normal, sign * 0.004),
                normal.clone().multiplyScalar(-sign),
                0,
                0.008,
              );
              expect(
                ray.intersectObjects(meshes).length,
                `${map.name} ${lod}: prism ${f.prism} edge ${f.edge} end ${end}, depth ${depth}, y ${point.y}`,
              ).toBeGreaterThan(0);
              probes++;
            }
          }
          expect(
            probes,
            `unprobed short/full joint at ${corner.toArray().join(',')}`,
          ).toBeGreaterThan(0);
        }
        for (const mesh of meshes) mesh.geometry.dispose();
        material.dispose();
      }
    },
    30_000,
  );
});
