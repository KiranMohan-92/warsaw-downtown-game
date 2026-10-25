import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildLightmapLayout, getMap, PALACE_TINT, resolveMap } from '@wd/shared';
import { facadeFaces } from './facadeRelief.ts';
import {
  palaceCrowns,
  palaceCrownGeometry,
  palaceClockGeometry,
  palaceSpireGeometry,
  PALACE_ATTIC_MIN_RUN,
  PALACE_ATTIC_PITCH,
} from './palaceSilhouette.ts';

const map = resolveMap(getMap('defilad'), 'market');
const faces = facadeFaces(map, PALACE_TINT);

describe('Palace skyline geometry', () => {
  it('crowns every exposed setback, including wing and entrance roofs', () => {
    const crowns = palaceCrowns(faces, map.prisms ?? []);
    expect([...new Set(crowns.map((c) => c.face.y1))].sort((a, b) => a - b)).toEqual([
      16, 22, 24, 34, 62, 110, 140, 165, 188, 205, 220,
    ]);
    for (const f of faces.filter((f) => f.style === 'monumental' && f.y1 >= 16 && f.y1 < 237)) {
      const runs = crowns.filter((c) => c.sources.includes(f));
      const spans = runs.map((r) => [r.face.sa + r.s0 - f.sa, r.face.sa + r.s1 - f.sa]);
      const cuts = [
        ...new Set([
          0,
          f.len,
          ...f.cover.flatMap((b) => [b.x0, b.x1]),
          ...spans.flat().filter((s) => s > 0 && s < f.len),
        ]),
      ].sort((a, b) => a - b);
      for (let i = 1; i < cuts.length; i++) {
        // Convex decomposition has micron-long edge fragments; match the 10 µm merge tolerance.
        if (cuts[i]! - cuts[i - 1]! < 1e-5) continue;
        const s = (cuts[i - 1]! + cuts[i]!) / 2;
        // Roof exposure is independent of the wall-cover probe. Sample infinitesimally
        // outside each interval against the raw roof union, including buried/sliver pieces.
        const x = f.ax + f.dx * s + f.dz * 1e-7;
        const z = f.az + f.dz * s - f.dx * 1e-7;
        const covered = map.prisms!.some(
          (p, pi) =>
            pi !== f.prism &&
            p.visible !== false &&
            p.y0 <= f.y1 &&
            p.y1 >= f.y1 - 1e-6 &&
            p.pts.every((a, i) => {
              const b = p.pts[(i + 1) % p.pts.length]!;
              return (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) >= -1e-9;
            }),
        );
        expect(spans.filter(([lo, hi]) => lo! < s && hi! > s).length).toBe(covered ? 0 : 1);
      }
    }
  });

  it('seats cornices and connected crenels on the roof and keeps finials regularly spaced', () => {
    const crowns = palaceCrowns(faces, map.prisms ?? []);
    const pins = crowns.flatMap((c) =>
      c.pinnacles.map((s) => ({
        x: c.face.ax + c.face.dx * s - c.face.dz * 0.42,
        z: c.face.az + c.face.dz * s + c.face.dx * 0.42,
        y: c.face.y1,
      })),
    );
    for (const c of crowns) {
      const g = palaceCrownGeometry(c);
      expect(g.frame.pos.length).toBeGreaterThan(0);
      expect(Math.min(...g.frame.pos.filter((_, i) => i % 3 === 1))).toBeCloseTo(c.face.y1);
      for (const s of [c.corner0 ? 0.45 : null, c.corner1 ? c.face.len - 0.45 : null]) {
        if (s === null || c.face.len < PALACE_ATTIC_MIN_RUN) continue;
        const x = c.face.ax + c.face.dx * s - c.face.dz * 0.42;
        const z = c.face.az + c.face.dz * s + c.face.dx * 0.42;
        expect(pins.some((p) => p.y === c.face.y1 && Math.hypot(p.x - x, p.z - z) < 0.12)).toBe(
          true,
        );
      }
      for (let i = 1; i < c.pinnacles.length; i++)
        expect(c.pinnacles[i]! - c.pinnacles[i - 1]!).toBeLessThanOrEqual(PALACE_ATTIC_PITCH);
      // Every new roof ornament is at or above its source roof, including carve slivers.
      const f = c.face;
      // The cornice crosses an actual source roof edge, not a floating span.
      for (const s of [c.s0, (c.s0 + c.s1) / 2, c.s1]) {
        const x = f.ax + f.dx * s;
        const z = f.az + f.dz * s;
        expect(
          c.sources.some((source) => {
            const along = (x - source.ax) * source.dx + (z - source.az) * source.dz;
            const normal = (x - source.ax) * source.dz - (z - source.az) * source.dx;
            return (
              Math.abs(normal) < 1e-6 &&
              along >= -1e-6 &&
              along <= source.len + 1e-6 &&
              map.prisms![source.prism]!.y1 === f.y1
            );
          }),
        ).toBe(true);
      }
      for (let i = 0; i < g.frame.pos.length; i += 3) {
        const x = g.frame.pos[i]! - f.ax;
        const y = g.frame.pos[i + 1]!;
        const z = g.frame.pos[i + 2]! - f.az;
        const o = x * f.dz - z * f.dx;
        expect(o).toBeLessThanOrEqual(0.04 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(f.y1 - 1e-6);
      }
      const triangles = Array.from({ length: g.frame.idx.length / 3 }, (_, i) =>
        g.frame.idx.slice(i * 3, i * 3 + 3),
      );
      expect(
        triangles.some(
          (vertices) =>
            vertices.every((v) => Math.abs(g.frame.pos[v * 3 + 1]! - f.y1) < 1e-6) &&
            g.frame.nrm[vertices[0]! * 3 + 1]! < -0.99,
        ),
      ).toBe(true);
      for (const [s, cap, sign] of [
        [c.s0, c.corner0, -1],
        [c.s1, c.corner1, 1],
      ] as const) {
        // Shared miter ends are closed by the adjacent band, with no internal cap.
        if (!cap || (s === c.s0 ? c.miter0 : c.miter1)) continue;
        expect(
          triangles.some((vertices) => {
            const offset = vertices[0]! * 3;
            const alongNormal = g.frame.nrm[offset]! * f.dx + g.frame.nrm[offset + 2]! * f.dz;
            return (
              alongNormal * sign > 0.99 &&
              vertices.every(
                (v) =>
                  Math.abs(
                    (g.frame.pos[v * 3]! - f.ax) * f.dx +
                      (g.frame.pos[v * 3 + 2]! - f.az) * f.dz -
                      s,
                  ) < 1e-5,
              )
            );
          }),
        ).toBe(true);
      }
      // Each roof run is bounded even at far LOD; no separate mesh/draw is required.
      expect(g.frame.idx.length / 3).toBeLessThan(600);
    }
  });

  it('has valid winding, normals and deterministic buffers for crowns, clocks and spire', () => {
    const crowns = palaceCrowns(faces, map.prisms ?? []);
    const a = [
      ...crowns.flatMap((c) => Object.values(palaceCrownGeometry(c))),
      ...palaceClockGeometry(faces),
      palaceSpireGeometry(faces)!,
    ];
    const b = [
      ...crowns.flatMap((c) => Object.values(palaceCrownGeometry(c))),
      ...palaceClockGeometry(faces),
      palaceSpireGeometry(faces)!,
    ];
    expect(b).toEqual(a);
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const r = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (const g of a) {
      expect(g.uv.length).toBe((g.pos.length / 3) * 2);
      expect(g.col.length).toBe(g.pos.length);
      for (let i = 0; i < g.idx.length; i += 3) {
        p.fromArray(g.pos, g.idx[i]! * 3);
        q.fromArray(g.pos, g.idx[i + 1]! * 3);
        r.fromArray(g.pos, g.idx[i + 2]! * 3);
        n.fromArray(g.nrm, g.idx[i]! * 3);
        expect(q.sub(p).cross(r.sub(p)).dot(n)).toBeGreaterThan(1e-8);
      }
    }
    expect(palaceClockGeometry(faces)).toHaveLength(4);
    const clockFaces = faces.filter(
      (f) =>
        f.style === 'monumental' && f.y0 === 165 && f.y1 === 188 && Math.abs(f.len - 20) < 1e-5,
    );
    palaceClockGeometry(faces).forEach((clock, i) => {
      const face = clockFaces[i]!;
      for (let j = 0; j < clock.nrm.length; j += 3)
        expect(clock.nrm[j]! * face.dz - clock.nrm[j + 2]! * face.dx).toBeCloseTo(1);
    });
    const spire = palaceSpireGeometry(faces)!;
    expect(Math.max(...spire.pos.filter((_, i) => i % 3 === 1))).toBe(237);
    for (let i = 0; i < spire.idx.length; i += 3) {
      const vertices = spire.idx.slice(i, i + 3);
      const x = vertices.reduce((sum, index) => sum + spire.pos[index * 3]!, 0) / 3;
      const z = vertices.reduce((sum, index) => sum + spire.pos[index * 3 + 2]!, 0) / 3;
      const offset = vertices[0]! * 3;
      expect(x * spire.nrm[offset]! + z * spire.nrm[offset + 2]!).toBeGreaterThan(0);
    }
  });

  it('preserves collision/map output and the shipped Market bake layout', () => {
    const before = JSON.stringify(map);
    for (const c of palaceCrowns(faces, map.prisms ?? [])) palaceCrownGeometry(c);
    palaceClockGeometry(faces);
    palaceSpireGeometry(faces);
    expect(JSON.stringify(map)).toBe(before);
    expect(buildLightmapLayout(map).hash).toBe('1f8605625ccbab');
  });
});
