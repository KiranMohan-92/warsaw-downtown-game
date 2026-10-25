import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MapFoliage } from '@wd/shared';
import {
  BUSH_CORE,
  FRINGE_SOLID,
  GRASS_BLADES,
  GRASS_CORE,
  bushArchetype,
  grassArchetype,
} from './foliageGeometry.ts';
import {
  SPRIG_NEAR_FADE,
  buildFoliageLayer,
  canopyMean,
  foliageMaterials,
  sprigLeafScale,
} from './foliageMesh.ts';

const compile = (mat: THREE.Material): THREE.WebGLProgramParametersWithUniforms => {
  const shader = {
    uniforms: {} as Record<string, THREE.IUniform>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
};

describe('hedge close-up', () => {
  it('leaf sprigs are six-point leaf outlines, each vertex knowing its stem', () => {
    const g = bushArchetype();
    let sprigVerts = 0;
    for (let i = 0; i < g.vertexCount; i++) {
      const sprig = g.fol[i * 3 + 2] === FRINGE_SOLID;
      if (sprig) sprigVerts++;
      expect(Number.isNaN(g.stem[i * 3]!)).toBe(!sprig);
    }
    expect(sprigVerts).toBe(BUSH_CORE.sprigs * BUSH_CORE.leavesPerSprig * 6);
    const geo = g.toGeometry();
    expect(geo.userData.sprigStem).toBeInstanceOf(Float32Array);
  });

  it('sprig leaves keep one world size on a long, low hedge (no stretched kites)', () => {
    const hedge: MapFoliage = { x: 0, z: 0, r: 3, h: 1.2, kind: 'bush' };
    const g = bushArchetype();
    const [group] = buildFoliageLayer({
      name: 't',
      bounds: { minX: -9, maxX: 9, minZ: -9, maxZ: 9 },
      boxes: [],
      spawns: [],
      dummies: [],
      foliage: [hedge],
    });
    const fringe = group!.children.find((c) => c.name === 'foliage:fringe') as THREE.Mesh;
    const pos = fringe.geometry.getAttribute('position');
    // Each leaf = 6 consecutive kept vertices (stem first); compare its extent in x/z vs y.
    let horiz = 0;
    let vert = 0;
    let unitLen = 0;
    for (let i = 0; i + 5 < pos.count; i += 6) {
      const s = new THREE.Vector3().fromBufferAttribute(pos, i);
      const tip = new THREE.Vector3().fromBufferAttribute(pos, i + 3);
      horiz += Math.hypot(tip.x - s.x, tip.z - s.z);
      vert += Math.abs(tip.y - s.y);
    }
    for (let i = 0; i < g.vertexCount; i += 6) {
      if (g.fol[i * 3 + 2] !== FRINGE_SOLID) continue;
      unitLen += Math.hypot(
        g.pos[(i + 3) * 3]! - g.pos[i * 3]!,
        g.pos[(i + 3) * 3 + 1]! - g.pos[i * 3 + 1]!,
        g.pos[(i + 3) * 3 + 2]! - g.pos[i * 3 + 2]!,
      );
    }
    const leaves = pos.count / 6;
    const meanLen = Math.hypot(horiz / leaves, vert / leaves);
    // Stretching by (3, 1.2, 3) would make leaves ~2.5× longer across than up; uniform scale
    // keeps the unit-space proportions and a leaf-sized length.
    const unitMean = unitLen / (BUSH_CORE.sprigs * BUSH_CORE.leavesPerSprig);
    expect(meanLen).toBeLessThan(unitMean * sprigLeafScale(hedge) * 1.35);
    expect(sprigLeafScale(hedge)).toBe(1.2);
    expect(sprigLeafScale({ r: 0.4, h: 2 })).toBe(0.8);
    expect(sprigLeafScale({ r: 4, h: 3 })).toBe(1.5);
  });

  it('shrinks sprigs into the hedge about their stems up close (geometry, no dither), every tier', () => {
    const { lit } = foliageMaterials();
    const shader = compile(lit);
    // Vertex shader, outside any alpha-test block: Low (no alpha test) shrinks them too.
    expect(shader.vertexShader).toContain('aFoliageRoot.w < 0.0');
    expect(shader.vertexShader).toContain('sprigScale');
    expect(shader.fragmentShader).not.toContain('sprigFade');
    expect(shader.fragmentShader).not.toContain('sprigNoise');
    expect(SPRIG_NEAR_FADE[1]).toBeCloseTo(1.2);
    expect(shader.fragmentShader).toContain('textureGrad( map');
    expect(canopyMean.value).toBeGreaterThan(0.01);
    expect(canopyMean.value).toBeLessThan(0.6);
    expect(lit.map!.anisotropy).toBeGreaterThanOrEqual(8);
  });

  it('sprig vertices carry their stem as root (w < 0); the core keeps the plant root', () => {
    const hedge: MapFoliage = { x: 4, z: -2, r: 1.6, h: 1.4, kind: 'bush' };
    const [group] = buildFoliageLayer({
      name: 't',
      bounds: { minX: -9, maxX: 9, minZ: -9, maxZ: 9 },
      boxes: [],
      spawns: [],
      dummies: [],
      foliage: [hedge],
    });
    const near = group!.children.find((c) => c.name === 'foliage:clumps') as THREE.Mesh;
    const root = near.geometry.getAttribute('aFoliageRoot');
    const fol = near.geometry.getAttribute('aFoliage');
    const pos = near.geometry.getAttribute('position');
    let sprigs = 0;
    for (let i = 0; i < root.count; i++) {
      if (fol.getZ(i) === FRINGE_SOLID) {
        sprigs++;
        expect(root.getW(i)).toBeCloseTo(-hedge.r, 5);
        // The stem is within a leaf's length of the vertex.
        const d = Math.hypot(
          pos.getX(i) - root.getX(i),
          pos.getY(i) - root.getY(i),
          pos.getZ(i) - root.getZ(i),
        );
        expect(d).toBeLessThan(0.25);
      } else {
        expect(root.getW(i)).toBeCloseTo(hedge.r, 5);
        expect(root.getX(i)).toBeCloseTo(hedge.x, 5);
      }
    }
    expect(sprigs).toBeGreaterThan(0);
  });
});

describe('tall-grass clump core', () => {
  it('tiles the thatch band round the clump, mirrored every other run (seamless)', () => {
    const g = grassArchetype();
    // Side vertices of the core ring at y = 0: u spans the tile `around` times.
    let flips = 0;
    let prev: number | null = null;
    const us: number[] = [];
    for (let i = 0; i < g.vertexCount; i++) {
      if (g.fol[i * 3 + 2] !== 1 || g.pos[i * 3 + 1] !== 0 || g.nrm[i * 3 + 1]! < -0.5) continue;
      us.push(g.uv[i * 2]!);
    }
    for (const u of us) {
      if (prev !== null && Math.abs(u - prev) > 1e-9) flips++;
      prev = u;
    }
    expect(us.length).toBe(GRASS_CORE.around * (GRASS_CORE.segs / GRASS_CORE.around + 1));
    expect(flips).toBeGreaterThan(GRASS_CORE.segs / 2);
    // Only the opaque tuft band is used (never the ragged alpha tips).
    const v = [...g.uv].filter((_, k) => k % 2 === 1);
    const tile = { v0: 384 / 1024, v1: 512 / 1024 };
    const coreV: number[] = [];
    for (let i = 0; i < g.vertexCount; i++) if (g.fol[i * 3 + 2] === 1) coreV.push(v[i]!);
    const maxT = Math.max(...coreV.map((x) => (x - tile.v0) / (tile.v1 - tile.v0)));
    expect(maxT).toBeLessThanOrEqual(GRASS_CORE.v1 + 0.01);
  });

  it('breaks the drum: opaque blades over the crown, rim and wall, roots inside the core', () => {
    const g = grassArchetype();
    let blades = 0;
    let aboveTop = 0;
    let outside = 0;
    for (let i = 0; i < g.vertexCount; i++) {
      const solid = g.fol[i * 3 + 2]!;
      const y = g.pos[i * 3 + 1]!;
      const r = Math.hypot(g.pos[i * 3]!, g.pos[i * 3 + 2]!);
      if (solid === 1) {
        // The core crown only rises above the concealment top; side coverage remains unchanged.
        expect(y).toBeLessThanOrEqual(1 + GRASS_CORE.crownPeakLift + 1e-9);
        continue;
      }
      // Everything else is an opaque blade (drawn on every tier; never an alpha card).
      expect(solid).toBe(FRINGE_SOLID);
      blades++;
      if (y > 1.08) aboveTop++;
      if (r > 1.03) outside++;
      expect(r).toBeLessThanOrEqual(GRASS_BLADES.maxReach + 1e-9);
      expect(y).toBeLessThanOrEqual(GRASS_BLADES.maxTip + 1e-9);
    }
    expect(blades).toBeGreaterThan(1000);
    // Tips at many heights above the top and round the side: the outline is grass, not a cut.
    expect(aboveTop / blades).toBeGreaterThan(0.1);
    expect(outside / blades).toBeGreaterThan(0.2);
    // Rim ring rises unevenly (soft top), never below 1.
    const rim = [];
    for (let i = 0; i < g.vertexCount; i++) {
      if (g.fol[i * 3 + 2] !== 1) continue;
      const r = Math.hypot(g.pos[i * 3]!, g.pos[i * 3 + 2]!);
      if (r > 1 && g.pos[i * 3 + 1]! >= 1) rim.push(g.pos[i * 3 + 1]!);
    }
    expect(Math.min(...rim)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...rim) - Math.min(...rim)).toBeGreaterThan(0.01);
  });

  it('keeps the solid side outside the concealment cylinder while the crown rises above it', () => {
    const g = grassArchetype();
    const rings = new Map<string, Map<string, { x: number; z: number }>>();
    let crownMinY = Infinity;
    let crownMaxY = -Infinity;
    for (let i = 0; i < g.vertexCount; i++) {
      if (g.fol[i * 3 + 2] !== 1) continue;
      const x = g.pos[i * 3]!;
      const y = g.pos[i * 3 + 1]!;
      const z = g.pos[i * 3 + 2]!;
      const r = Math.hypot(x, z);
      if (y > 1 + 1e-6) {
        crownMinY = Math.min(crownMinY, y);
        crownMaxY = Math.max(crownMaxY, y);
      }
      if (y > 1 + 1e-6 || r < 0.95 || g.nrm[i * 3 + 1]! < -0.5) continue;
      const yKey = y.toFixed(5);
      const aKey = Math.atan2(z, x).toFixed(5);
      const byAngle = rings.get(yKey) ?? new Map<string, { x: number; z: number }>();
      const prev = byAngle.get(aKey);
      if (!prev || Math.hypot(x, z) > Math.hypot(prev.x, prev.z)) byAngle.set(aKey, { x, z });
      rings.set(yKey, byAngle);
    }
    expect(rings.size).toBeGreaterThanOrEqual(3);
    for (const byAngle of rings.values()) {
      const pts = [...byAngle.values()].sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
      expect(pts.length).toBe(GRASS_CORE.segs);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const edge = Math.hypot(b.x - a.x, b.z - a.z);
        const apothem = Math.abs(a.x * b.z - a.z * b.x) / edge;
        expect(apothem).toBeGreaterThanOrEqual(1);
      }
    }
    expect(crownMinY).toBeGreaterThan(1);
    expect(crownMaxY).toBeGreaterThan(1.15);
    expect(crownMaxY - crownMinY).toBeGreaterThan(0.08);
  });

  it('keeps sleeve blades narrow enough to read as grass clusters, not broad sheets', () => {
    const g = grassArchetype();
    let checked = 0;
    for (let i = 0; i < g.idx.length; i += 3) {
      const tri = [g.idx[i]!, g.idx[i + 1]!, g.idx[i + 2]!];
      if (tri.some((v) => g.fol[v * 3 + 2] !== FRINGE_SOLID)) continue;
      const pts = tri.map((v) => ({
        x: g.pos[v * 3]!,
        y: g.pos[v * 3 + 1]!,
        z: g.pos[v * 3 + 2]!,
      }));
      const ySpan = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
      if (ySpan < 0.55) continue;
      for (const [a, b] of [
        [pts[0]!, pts[1]!],
        [pts[1]!, pts[2]!],
        [pts[2]!, pts[0]!],
      ] as const) {
        if (Math.abs(a.y - b.y) > 0.08) continue;
        if (Math.max(a.y, b.y) > 0.78) continue;
        const r = (Math.hypot(a.x, a.z) + Math.hypot(b.x, b.z)) * 0.5;
        if (r < 0.95 || r > GRASS_BLADES.maxReach + 1e-6) continue;
        checked++;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThanOrEqual(0.05);
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('shows opaque skirt blades before the solid core on close side views', () => {
    const mesh = new THREE.Mesh(
      grassArchetype().toGeometry(),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    const ray = new THREE.Raycaster();
    const foliage = mesh.geometry.getAttribute('aFoliage');
    let tested = 0;
    let bladeFirst = 0;
    const weakBuckets: string[] = [];
    for (let a = 0; a < 32; a++) {
      const angle = (a / 32) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const side = new THREE.Vector3(-dir.z, 0, dir.x);
      for (const y of [0.08, 0.18, 0.32, 0.46, 0.6, 0.74, 0.88, 1.02]) {
        let bucketTested = 0;
        let bucketBladeFirst = 0;
        for (const off of [-0.72, -0.36, 0, 0.36, 0.72]) {
          const from = dir.clone().multiplyScalar(3).add(side.clone().multiplyScalar(off)).setY(y);
          const to = dir.clone().multiplyScalar(-3).add(side.clone().multiplyScalar(off)).setY(y);
          const delta = to.clone().sub(from);
          ray.set(from, delta.clone().normalize());
          ray.far = delta.length();
          const hit = ray.intersectObject(mesh, false)[0];
          if (!hit?.face) continue;
          tested++;
          bucketTested++;
          const solid =
            foliage.getZ(hit.face.a) * hit.barycoord!.x +
            foliage.getZ(hit.face.b) * hit.barycoord!.y +
            foliage.getZ(hit.face.c) * hit.barycoord!.z;
          if (Math.abs(solid - FRINGE_SOLID) < 1e-5) {
            bladeFirst++;
            bucketBladeFirst++;
          }
        }
        if (bucketTested > 0 && bucketBladeFirst / bucketTested < 0.8)
          weakBuckets.push(`${a}@${y}:${bucketBladeFirst}/${bucketTested}`);
      }
    }
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    expect(tested).toBeGreaterThan(1000);
    expect(bladeFirst / tested).toBeGreaterThanOrEqual(0.8);
    expect(weakBuckets).toEqual([]);
  });

  it('puts visible crown blade tips above the opaque cap with irregular heights', () => {
    const g = grassArchetype();
    const mesh = new THREE.Mesh(
      g.toGeometry(),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    );
    const foliage = mesh.geometry.getAttribute('aFoliage');
    const solidAt = (hit: THREE.Intersection): number =>
      hit.face && hit.barycoord
        ? foliage.getZ(hit.face.a) * hit.barycoord.x +
          foliage.getZ(hit.face.b) * hit.barycoord.y +
          foliage.getZ(hit.face.c) * hit.barycoord.z
        : 0;
    const ray = new THREE.Raycaster();
    const bins = 16;
    const highEmergence = Array.from({ length: bins }, () => 0);
    const emergence: number[] = [];
    let clamped = 0;
    const maxTipV = Math.max(
      ...Array.from({ length: g.vertexCount }, (_, i) =>
        g.fol[i * 3 + 2] === FRINGE_SOLID ? g.uv[i * 2 + 1]! : -Infinity,
      ),
    );
    for (let i = 0; i < g.vertexCount; i++) {
      if (g.fol[i * 3 + 2] !== FRINGE_SOLID) continue;
      if (Math.abs(g.uv[i * 2 + 1]! - maxTipV) > 1e-8) continue;
      const x = g.pos[i * 3]!;
      const y = g.pos[i * 3 + 1]!;
      const z = g.pos[i * 3 + 2]!;
      const r = Math.hypot(x, z);
      if (r > 1.08 || y < 1.1) continue;
      ray.set(new THREE.Vector3(x, 2, z), new THREE.Vector3(0, -1, 0));
      ray.far = 2;
      const cap = ray.intersectObject(mesh, false).find((hit) => Math.abs(solidAt(hit) - 1) < 1e-5);
      if (!cap) continue;
      const visible = y - cap.point.y;
      const angle = Math.atan2(z, x);
      const bin = Math.floor((((angle + Math.PI) / (Math.PI * 2)) * bins) % bins);
      highEmergence[bin] = Math.max(highEmergence[bin]!, visible);
      emergence.push(visible);
      if (Math.abs(y - GRASS_BLADES.maxTip) < 1e-6) clamped++;
    }
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    expect(highEmergence.filter((y) => y >= 0.15).length).toBeGreaterThanOrEqual(bins - 1);
    expect(highEmergence.some((y) => y >= 0.2)).toBe(true);
    expect(Math.min(...highEmergence)).toBeGreaterThanOrEqual(0.12);
    expect(Math.max(...emergence) - Math.min(...emergence)).toBeGreaterThanOrEqual(0.18);
    expect(clamped / emergence.length).toBeLessThan(0.02);
  });

  it('keeps the solid grass core dark enough to read as depth behind the blades', () => {
    const g = grassArchetype();
    const side: { y: number; r: number; g: number; b: number }[] = [];
    for (let i = 0; i < g.vertexCount; i++) {
      if (g.fol[i * 3 + 2] !== 1) continue;
      const y = g.pos[i * 3 + 1]!;
      const r = Math.hypot(g.pos[i * 3]!, g.pos[i * 3 + 2]!);
      if (r > 1 && y <= 1 && Math.abs(g.nrm[i * 3 + 1]!) < 0.95)
        side.push({ y, r: g.col[i * 3]!, g: g.col[i * 3 + 1]!, b: g.col[i * 3 + 2]! });
    }
    const mean = (values: number[]): number =>
      values.reduce((sum, v) => sum + v, 0) / values.length;
    const base = mean(side.filter((p) => p.y < 0.12).map((p) => p.r));
    const upper = mean(side.filter((p) => p.y > 0.6).map((p) => p.r));
    const greenBias = mean(side.map((p) => p.g / Math.max(p.r, p.b)));
    expect(base).toBeLessThanOrEqual(0.24);
    expect(upper).toBeLessThanOrEqual(0.65);
    expect(upper).toBeGreaterThan(base * 1.8);
    expect(greenBias).toBeGreaterThan(1.1);
  });

  it('keeps the visible grass archetype within the Round 2 triangle budget', () => {
    const baseline = 5139;
    const maxRound2 = Math.floor(baseline * 1.3);
    expect(grassArchetype().triangleCount).toBeLessThanOrEqual(maxRound2);
  });
});
