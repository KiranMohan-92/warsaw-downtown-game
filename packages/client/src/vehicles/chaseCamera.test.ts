import { describe, expect, it } from 'vitest';
import type { MapTree } from '@wd/shared';
import {
  CHASE_FRAMINGS,
  crownClear,
  crownOf,
  crownsNear,
  FramingSmoother,
  framingPoint,
  pickFraming,
  insideCrown,
  segmentCrown,
  type Crown,
} from './chaseCamera.ts';

const noWall = (a: { x: number; y: number; z: number }, b: typeof a): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const pivot = { x: 0, y: 2.6, z: 0 };
// yaw 0: the camera sits back along +z.
// A broadleaf (ellipsoid) crown centred at height y, rx wide and ry tall (half sizes).
const behind = (z: number, y: number, rx: number, ry: number, x = 0): Crown => ({
  x,
  z,
  base: y - ry,
  top: y + ry,
  r: rx,
  cone: false,
});

describe('chase camera vs tree crowns', () => {
  it('a crown is the upper part of the drawn tree, as wide as its model', () => {
    const t: MapTree = { x: 3, z: 4, height: 10, crown: 3, kind: 'broadleaf' };
    const c = crownOf(t);
    expect(c.x).toBe(3);
    expect(c.z).toBe(4);
    expect(c.base).toBeCloseTo(4, 5); // above the trunk's lower part
    expect(c.top).toBeCloseTo(10, 5);
    expect(c.r).toBeGreaterThan(2);
    expect(c.r).toBeLessThan(5);
    expect(c.cone).toBe(false);
    // A pine: a cone from its low branches, widest at the bottom.
    const pine = crownOf({ ...t, kind: 'conifer' });
    expect(pine.cone).toBe(true);
    expect(pine.base).toBeLessThan(3);
    expect(insideCrown({ x: 3 + pine.r * 0.8, y: pine.base + 0.3, z: 4 }, pine)).toBe(true);
    expect(insideCrown({ x: 3 + pine.r * 0.8, y: pine.top - 1, z: 4 }, pine)).toBe(false);
  });

  it('finds where a segment enters an ellipsoid, and misses one beside it', () => {
    const c = behind(5, 2.6, 2, 2);
    const t = segmentCrown(pivot, { x: 0, y: 2.6, z: 10 }, c, 0);
    expect(t).toBeCloseTo(0.3, 2);
    expect(segmentCrown(pivot, { x: 0, y: 2.6, z: 10 }, { ...c, x: 5 }, 0)).toBeNull();
    expect(segmentCrown(pivot, { x: 0, y: 2.6, z: 2 }, c, 0)).toBeNull(); // stops short
  });

  it('keeps the default framing in the open', () => {
    expect(pickFraming(pivot, 0, -0.1, [], noWall)).toBe(0);
  });

  it('steps closer and higher when a low crown is behind the truck', () => {
    // A crown low over the road 5–9 m back: the default line runs into it, a closer one doesn't.
    const crowns = [behind(7.5, 3.4, 2.2, 1.6)];
    const want = framingPoint(
      pivot,
      0,
      -0.1,
      CHASE_FRAMINGS[0]!.distance,
      CHASE_FRAMINGS[0]!.lift,
      {
        x: 0,
        y: 0,
        z: 0,
      },
    );
    expect(crownClear(pivot, want, crowns)).toBeLessThan(1);
    const i = pickFraming(pivot, 0, -0.1, crowns, noWall);
    expect(i).toBeGreaterThan(0);
    const f = CHASE_FRAMINGS[i]!;
    expect(f.distance).toBeLessThan(CHASE_FRAMINGS[0]!.distance);
    expect(f.lift).toBeGreaterThan(CHASE_FRAMINGS[0]!.lift);
    const near = framingPoint(pivot, 0, -0.1, f.distance, f.lift, { x: 0, y: 0, z: 0 });
    expect(crownClear(pivot, near, crowns)).toBe(1);
  });

  it('a crown behind a wall does not change the framing', () => {
    const crowns = [behind(7.5, 3.4, 2.2, 1.6)];
    expect(pickFraming(pivot, 0, -0.1, crowns, () => 3)).toBe(0);
  });

  it('a crown the truck is under does not pin the camera to the pivot', () => {
    const over = behind(0, 3, 4, 2);
    expect(crownClear(pivot, { x: 0, y: 3, z: 6.8 }, [over])).toBe(1);
  });

  it('with every framing blocked, the camera still stops short of the leaves', () => {
    const wall = [behind(4.5, 3, 3, 3)];
    const i = pickFraming(pivot, 0, -0.1, wall, noWall);
    const f = CHASE_FRAMINGS[i]!;
    const p = framingPoint(pivot, 0, -0.1, f.distance, f.lift, { x: 0, y: 0, z: 0 });
    const t = crownClear(pivot, p, wall);
    expect(t).toBeLessThan(1);
    const cam = { x: 0, y: pivot.y + (p.y - pivot.y) * t, z: p.z * t };
    expect(cam.z).toBeGreaterThan(0.5); // not pinned to the truck
    expect(insideCrown(cam, wall[0]!)).toBe(false);
  });

  it('the pine beside the road in veh_3: the camera ends up out of its branches', () => {
    // Market truck 2 driving +x past the pine at (51.3, 32.3); the camera sits back along -x.
    const pine = crownOf({ x: 51.27, z: 32.31, height: 12.66, crown: 2.2, kind: 'conifer' });
    const at = { x: 47, y: 2.6, z: 31 };
    const yaw = -Math.PI / 2;
    const i = pickFraming(at, yaw, -0.14, [pine], noWall);
    const f = CHASE_FRAMINGS[i]!;
    const p = framingPoint(at, yaw, -0.14, f.distance, f.lift, { x: 0, y: 0, z: 0 });
    const t = crownClear(at, p, [pine]);
    const cam = {
      x: at.x + (p.x - at.x) * t,
      y: at.y + (p.y - at.y) * t,
      z: at.z + (p.z - at.z) * t,
    };
    expect(insideCrown(cam, pine)).toBe(false);
    expect(Math.hypot(cam.x - at.x, cam.z - at.z)).toBeGreaterThan(2);
  });

  it('only nearby crowns are tested', () => {
    const crowns = [behind(5, 3, 2, 2), behind(0, 3, 2, 2, 40)];
    expect(crownsNear(crowns, pivot, 9)).toHaveLength(1);
  });

  it('closes in at once, eases back out only after staying clear', () => {
    const s = new FramingSmoother();
    s.update(2, 1 / 60);
    expect(s.framing).toBe(2);
    for (let i = 0; i < 60; i++) s.update(2, 1 / 60);
    expect(s.distance).toBeCloseTo(CHASE_FRAMINGS[2]!.distance, 1);
    // Clear for a few frames (crown edge flicker): stays.
    for (let i = 0; i < 10; i++) s.update(0, 1 / 60);
    expect(s.framing).toBe(2);
    s.update(2, 1 / 60);
    for (let i = 0; i < 40; i++) s.update(0, 1 / 60);
    expect(s.framing).toBe(0);
    s.reset();
    expect(s.distance).toBe(CHASE_FRAMINGS[0]!.distance);
  });
});

describe('tree fade between the chase camera and the truck', () => {
  it('patches the near tree materials with the shared line-of-sight uniforms', async () => {
    const THREE = await import('three');
    const { addTreeFade, setTreeFade, treeFade } = await import('../render/treeModels.ts');
    const m = new THREE.MeshStandardMaterial();
    m.customProgramCacheKey = () => 'wet';
    addTreeFade(m);
    expect(m.customProgramCacheKey()).toBe('wet|treeFade');
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    m.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms.uFadeR).toBe(treeFade.r);
    expect(shader.vertexShader).toContain('vFadeWorld = ');
    expect(shader.fragmentShader).toContain('discard');
    setTreeFade({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, 2.2);
    expect(treeFade.b.value.z).toBe(6);
    expect(treeFade.r.value).toBe(2.2);
    treeFade.r.value = 0;
  });
});
