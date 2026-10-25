import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3, WorldHit, WorldRaycaster } from '@wd/shared';
import {
  CHUNKS,
  CHUNK_MATERIAL,
  ChunkDebris,
  bounceSpin,
  chunkDrawScale,
  chunkGeometry,
  restPose,
} from './chunks.ts';

/** Analytic planes: the floor y = `floor` and an optional wall x = `wall` (facing −x). */
class Planes implements WorldRaycaster {
  rays = 0;
  visibleRays = 0;
  constructor(
    readonly floor = 0,
    readonly wall: number | null = null,
    /** An invisible collision-only slab this high over the floor (castRay sees it). */
    readonly helper = 0,
  ) {}
  castRay(o: Vec3, d: Vec3, max: number): WorldHit | null {
    this.rays++;
    return this.cast(o, d, max, this.floor + this.helper);
  }
  castVisibleRay(o: Vec3, d: Vec3, max: number): WorldHit | null {
    this.visibleRays++;
    return this.cast(o, d, max, this.floor);
  }
  private cast(o: Vec3, d: Vec3, max: number, floor: number): WorldHit | null {
    let best: WorldHit | null = null;
    if (d.y < 0) {
      const t = (floor - o.y) / d.y;
      if (t >= 0 && t <= max) best = hit(o, d, t, { x: 0, y: 1, z: 0 });
    }
    if (this.wall !== null && d.x > 0) {
      const t = (this.wall - o.x) / d.x;
      if (t >= 0 && t <= max && (!best || t < best.distance))
        best = hit(o, d, t, { x: -1, y: 0, z: 0 });
    }
    return best;
  }
}
const hit = (o: Vec3, d: Vec3, t: number, normal: Vec3): WorldHit => ({
  distance: t,
  point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t },
  normal,
  visible: true,
  surface: 'stone',
});

const seq = (): (() => number) => {
  let s = 7;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};

const run = (fx: ChunkDebris, seconds: number, dt = 1 / 60): void => {
  for (let t = 0; t < seconds; t += dt) fx.update(dt);
};

describe('persistent chunk debris', () => {
  it('builds closed, jittered, unit-box chip and splinter shapes', () => {
    for (const shape of ['chip', 'splinter'] as const) {
      const g = chunkGeometry(shape);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      for (const v of [b.min.x, b.min.y, b.min.z]) expect(v).toBeCloseTo(-1, 5);
      for (const v of [b.max.x, b.max.y, b.max.z]) expect(v).toBeCloseTo(1, 5);
      // Flat-shaded and irregular: not a regular solid.
      const pos = g.getAttribute('position');
      const radii = new Set<number>();
      for (let i = 0; i < pos.count; i++) {
        radii.add(Math.round(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i)) * 100));
      }
      expect(radii.size).toBeGreaterThan(3);
    }
  });

  it('flies off the surface, falls, bounces, settles lying flat on the ground and stays', () => {
    const world = new Planes(0);
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(world);
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'stone', 10, [0.4, 0.4, 0.4], 0, seq());
    expect(fx.stats()).toEqual({ live: 10, flying: 10, resting: 0 });
    run(fx, 3);
    expect(fx.stats().resting).toBe(10);
    for (const c of fx.slots.filter((c) => c.life > 0)) {
      // On the floor, half its thickness up, its thin axis along the normal.
      expect(c.y).toBeCloseTo(c.sy, 4);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(
        new THREE.Quaternion(c.qx, c.qy, c.qz, c.qw),
      );
      expect(up.y).toBeCloseTo(1, 4);
      expect(c.x).toBeLessThan(0.05); // thrown out of the wall (−x), not through it
    }
    // Sleeping chunks cost no rays.
    const before = world.visibleRays;
    run(fx, 5);
    expect(world.visibleRays).toBe(before);
    // Still there after 40 s, gone by persist + fade.
    run(fx, 32);
    expect(fx.stats().resting).toBe(10);
    run(fx, CHUNKS.persist + CHUNKS.fade - 40 + 3);
    expect(fx.stats().live).toBe(0);
  });

  it('shrinks out at the end and eases its flight growth back to true size on landing', () => {
    const settled = { settled: true, grow: 3, rest: 0, life: 40 };
    expect(chunkDrawScale(settled)).toBeCloseTo(3);
    expect(chunkDrawScale({ ...settled, rest: CHUNKS.landEase / 2 })).toBeCloseTo(2);
    expect(chunkDrawScale({ ...settled, rest: 1 })).toBe(1);
    expect(chunkDrawScale({ ...settled, rest: 1, life: CHUNKS.fade / 2 })).toBeCloseTo(0.5);
    expect(chunkDrawScale({ settled: false, grow: 2, rest: 0, life: 99 })).toBe(2);
  });

  it('bounces off walls and comes down to the floor', () => {
    const world = new Planes(0, 1.2);
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(world);
    // A ground hit throwing chunks toward a wall 1.2 m away.
    fx.spawn(
      { x: 0, y: 0, z: 0 },
      { x: 0.7, y: 0.7, z: 0 },
      'stone',
      12,
      [0.4, 0.4, 0.4],
      0,
      seq(),
    );
    run(fx, 4);
    for (const c of fx.slots.filter((c) => c.life > 0)) {
      expect(c.settled).toBe(true);
      expect(c.x).toBeLessThan(1.2);
      expect(c.y).toBeCloseTo(c.sy, 4);
    }
  });

  it('bounces by material: stone chips spring back, dirt clods stop dead', () => {
    const peak = (surface: 'stone' | 'soft'): number => {
      const world = new Planes(0);
      const fx = new ChunkDebris();
      fx.setWorldRaycaster(world);
      fx.spawn(
        { x: 0, y: 2, z: 0 },
        { x: 0, y: -1, z: 0.001 },
        surface,
        1,
        [0.4, 0.4, 0.4],
        0,
        () => 0.5,
      );
      const c = fx.slots.find((c) => c.life > 0)!;
      c.vx = c.vz = 0;
      c.vy = -4;
      let bounced = false;
      let top = 0;
      for (let i = 0; i < 240; i++) {
        const vy = c.vy;
        fx.update(1 / 60);
        if (vy < 0 && c.vy > 0) bounced = true;
        if (bounced) top = Math.max(top, c.y);
      }
      return top;
    };
    expect(CHUNK_MATERIAL.stone.restitution).toBeGreaterThan(CHUNK_MATERIAL.soft.restitution);
    expect(peak('stone')).toBeGreaterThan(peak('soft'));
  });

  it('rolls on contact: the spin follows the surface motion', () => {
    const out = { x: 0, y: 0, z: 0 };
    // Sliding +x on the floor: rolling spin is about −z (n × v / r).
    bounceSpin({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 0.01, out);
    expect(out.z).toBeLessThan(0);
    expect(Math.abs(out.x)).toBeLessThan(1e-9);
    // Half the old spin survives.
    bounceSpin({ x: 10, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, 0.01, out);
    expect(out.x).toBeCloseTo(5);
  });

  it('lies on a slope along its normal', () => {
    const q = new THREE.Quaternion();
    const pos = { x: 0, y: 0, z: 0 };
    const n = new THREE.Vector3(0.3, 0.9, 0).normalize();
    restPose({ x: 1, y: 2, z: 3 }, n, 0.01, 0.7, pos, q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    expect(up.distanceTo(n)).toBeLessThan(1e-6);
    expect(Math.hypot(pos.x - 1, pos.y - 2, pos.z - 3)).toBeCloseTo(0.01);
  });

  it('collides with what is drawn, not collision-only helpers (stair ramps)', () => {
    const world = new Planes(0, null, 0.16);
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(world);
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'stone', 6, [0.4, 0.4, 0.4], 0, seq());
    run(fx, 3);
    expect(world.rays).toBe(0);
    for (const c of fx.slots.filter((c) => c.life > 0)) expect(c.y).toBeLessThan(0.05);
  });

  it('is bounded: a ring of persistent chunks (smaller on Low), capped in flight, no growth', () => {
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(new Planes(0));
    const slots = fx.slots;
    const records = new Set(slots);
    // In flight: never more than the active cap.
    let spawned = 0;
    for (let i = 0; i < 40; i++) {
      spawned += fx.spawn(
        { x: i, y: 1, z: 0 },
        { x: -1, y: 0, z: 0 },
        'stone',
        12,
        [0.4, 0.4, 0.4],
        0,
      );
    }
    expect(spawned).toBe(CHUNKS.activeCap);
    expect(fx.stats().flying).toBe(CHUNKS.activeCap);
    // Once they land, more can fly; the ring recycles the oldest.
    for (let k = 0; k < 6; k++) {
      run(fx, 3);
      for (let i = 0; i < 20; i++) {
        fx.spawn({ x: i, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'wood', 12, [0.5, 0.35, 0.2], 0);
      }
    }
    run(fx, 3);
    expect(fx.stats().live).toBe(CHUNKS.capacity);
    expect(fx.slots).toBe(slots);
    expect(new Set(fx.slots)).toEqual(records);
    expect(fx.chips.count + fx.splinters.count).toBe(CHUNKS.capacity);

    const low = new ChunkDebris();
    low.setLow(true);
    low.setWorldRaycaster(new Planes(0));
    let lowFlying = 0;
    for (let i = 0; i < 20; i++) {
      lowFlying += low.spawn(
        { x: i, y: 1, z: 0 },
        { x: -1, y: 0, z: 0 },
        'stone',
        12,
        [0.4, 0.4, 0.4],
        0,
      );
    }
    expect(lowFlying).toBe(CHUNKS.lowActiveCap);
    for (let k = 0; k < 4; k++) {
      run(low, 3);
      for (let i = 0; i < 10; i++) {
        low.spawn({ x: i, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'stone', 12, [0.4, 0.4, 0.4], 0);
      }
    }
    run(low, 3);
    expect(low.stats().live).toBe(CHUNKS.lowCapacity);
  });

  it('drops a chunk that falls out of the world', () => {
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(null); // nothing to land on
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0.2, z: 0 }, 'glass', 4, [0.8, 0.9, 0.9], 0, seq());
    run(fx, CHUNKS.maxAir + 0.5);
    expect(fx.stats().live).toBe(0);
  });

  it('draws chips and splinters as two instanced draws of one material, warmed up', () => {
    const fx = new ChunkDebris();
    expect(fx.chips.material).toBe(fx.splinters.material);
    expect(fx.chips.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    const restore = fx.beginWarmUp();
    expect(fx.chips.count).toBe(1);
    expect(fx.splinters.count).toBe(1);
    expect(fx.stats().live).toBe(0);
    restore();
    expect(fx.chips.count + fx.splinters.count).toBe(0);
    fx.setWorldRaycaster(new Planes(0));
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'wood', 5, [0.5, 0.35, 0.2], 0, seq());
    fx.update(1 / 60);
    expect(fx.splinters.count).toBe(5);
    expect(fx.chips.count).toBe(0);
  });

  it('makes glass shards and bare metal glossy per instance in the one chunk program', () => {
    const fx = new ChunkDebris();
    const mat = fx.chips.material as THREE.MeshStandardMaterial;
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    };
    mat.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('vGloss = aGloss;');
    expect(shader.fragmentShader).toContain(
      'roughnessFactor = mix(roughnessFactor, 0.06, vGloss);',
    );
    expect(shader.fragmentShader).toContain('metalnessFactor = mix(');
    expect(mat.customProgramCacheKey()).toBe(
      (fx.splinters.material as THREE.Material).customProgramCacheKey(),
    );
    fx.setWorldRaycaster(new Planes(0));
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'glass', 2, [0.8, 0.9, 0.9], 0, seq());
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'stone', 2, [0.4, 0.4, 0.4], 0, seq());
    fx.update(1 / 60);
    const gloss = fx.chips.geometry.getAttribute('aGloss');
    const values = [0, 1, 2, 3].map((i) => gloss.getX(i)).sort();
    expect(values).toEqual([0, 0, CHUNK_MATERIAL.glass.gloss, CHUNK_MATERIAL.glass.gloss]);
  });

  it('rests on the drawn paving, not the collision floor under it (map flats)', () => {
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(new Planes(0));
    const lift = 0.0145; // a layer-7 paving flat
    fx.setGroundLift((_x, y) => (Math.abs(y) < 0.05 ? lift : 0));
    fx.spawn({ x: 0, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, 'glass', 6, [0.8, 0.9, 0.9], 0, seq());
    run(fx, 3);
    for (const c of fx.slots.filter((c) => c.life > 0)) {
      expect(c.settled).toBe(true);
      // A 2–5 mm shard lies on top of the paving (which is drawn  m up), not under it.
      expect(c.y - c.sy).toBeCloseTo(lift, 5);
    }
  });

  it('never leaves a big chunk hanging: a wedged chunk is put to rest at its true size', () => {
    // A V-groove of two steep faces (n.y < 0.55): it bounces in place and never meets ground.
    const groove: WorldRaycaster = {
      castRay: () => null,
      castVisibleRay: (o, d, max) => {
        const t = Math.max(0, Math.min(max, 0.001));
        return {
          distance: t,
          point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t },
          normal: d.x > 0 ? { x: -0.9, y: 0.43, z: 0 } : { x: 0.9, y: 0.43, z: 0 },
          visible: true,
          surface: 'stone',
        };
      },
    };
    const fx = new ChunkDebris();
    fx.setWorldRaycaster(groove);
    // A 25 m readability floor: big flight growth.
    fx.spawn({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', 3, [0.4, 0.4, 0.4], 0.24, seq());
    run(fx, 1.5);
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const live = fx.slots.filter((c) => c.life > 0);
    expect(live.length).toBe(3);
    live.forEach((c, i) => {
      expect(c.settled).toBe(true);
      fx.chips.getMatrixAt(i, m);
      m.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      expect(scale.x).toBeCloseTo(c.sx, 6); // true size, no flight growth
    });
  });

  it('draws a slow flying chunk at its true size (the growth is for visible flight)', () => {
    const c = { settled: false, grow: 20, rest: 0, life: 10 };
    expect(chunkDrawScale(c, 0)).toBe(1);
    expect(chunkDrawScale(c, CHUNKS.growSpeed / 2)).toBeCloseTo(10.5);
    expect(chunkDrawScale(c, 10)).toBe(20);
  });

  it('leaves nothing drawn after the warm-up draw is restored', () => {
    const fx = new ChunkDebris();
    const restore = fx.beginWarmUp();
    expect(fx.chips.count + fx.splinters.count).toBe(2);
    restore();
    fx.update(1 / 60);
    expect(fx.chips.count + fx.splinters.count).toBe(0);
    expect(fx.stats().live).toBe(0);
  });

  it('eases from what was on screen into rest: no pop on landing (floor and groove)', () => {
    const groove: WorldRaycaster = {
      castRay: () => null,
      castVisibleRay: (o, d, max) => {
        const t = Math.max(0, Math.min(max, 0.001));
        return {
          distance: t,
          point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t },
          normal: d.x > 0 ? { x: -0.9, y: 0.43, z: 0 } : { x: 0.9, y: 0.43, z: 0 },
          visible: true,
          surface: 'stone',
        };
      },
    };
    for (const world of [new Planes(0), groove]) {
      const fx = new ChunkDebris();
      fx.setWorldRaycaster(world);
      // A ground hit (floor) or a hit high in the groove; a 25 m readability target.
      const at = world === groove ? 5 : 0;
      fx.spawn(
        { x: 0, y: at, z: 0 },
        { x: 0, y: 1, z: 0 },
        'stone',
        1,
        [0.4, 0.4, 0.4],
        0.24,
        seq(),
      );
      const c = fx.slots.find((k) => k.life > 0)!;
      const m = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const drawn: { scale: number; settled: boolean }[] = [];
      for (let f = 0; f < 240; f++) {
        fx.update(1 / 60);
        fx.chips.getMatrixAt(0, m);
        drawn.push({ scale: v.setFromMatrixScale(m).x / c.sx, settled: c.settled });
      }
      const landing = drawn.findIndex((d) => d.settled);
      expect(landing).toBeGreaterThan(0);
      // From the last flying frame through landing to rest, the drawn size never grows.
      for (let i = landing; i < drawn.length; i++) {
        expect(drawn[i]!.scale).toBeLessThanOrEqual(drawn[i - 1]!.scale + 1e-5); // float32 matrices
      }
      expect(drawn[drawn.length - 1]!.scale).toBeCloseTo(1, 6);
    }
  });
});
