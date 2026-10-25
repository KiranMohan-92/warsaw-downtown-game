import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { smokeShape, type SmokeCloud } from '@wd/shared';
import { DEBRIS, ImpactDebris, flashClearance, IMPACT_CAPACITY } from './debris.ts';
import type { ImpactPool } from './impactPool.ts';
import { READ_PX, puffScreenLimit } from './impactProfile.ts';
import { chunkDrawScale } from './chunks.ts';

const seq = (): (() => number) => {
  let s = 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
};

function chipMesh(d: ImpactDebris): THREE.InstancedMesh {
  const mesh = d.group.getObjectByName('fx:debris-chips') as THREE.InstancedMesh | undefined;
  expect(mesh).toBeDefined();
  return mesh!;
}

function spriteByName(
  d: ImpactDebris,
  name: 'fx:dust' | 'fx:sparks',
): THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshBasicMaterial> {
  const points = d.group.children.find(
    (o): o is THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshBasicMaterial> =>
      o instanceof THREE.Mesh &&
      o.geometry instanceof THREE.InstancedBufferGeometry &&
      o.name === name,
  );
  expect(points).toBeDefined();
  return points!;
}

function spriteMaterial(
  points: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshBasicMaterial>,
): THREE.MeshBasicMaterial {
  expect(points.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  return points.material;
}

function spriteAlpha(
  points: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshBasicMaterial>,
  index = 0,
): number {
  if (points.geometry.instanceCount === 0) return 0;
  const attr = points.geometry.getAttribute('color') as THREE.BufferAttribute;
  return attr.getW(index);
}

function advance(d: ImpactDebris, frames: number): void {
  for (let i = 0; i < frames; i++) d.update(1 / 60);
}

function decomposeChip(
  d: ImpactDebris,
  index = 0,
): { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 } {
  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  chipMesh(d).getMatrixAt(index, matrix);
  matrix.decompose(pos, quat, scale);
  return { pos, quat, scale };
}

describe('impact debris', () => {
  it('holds the rendered peak billow at 70–120 px at 10–25 m, including randomized source-plane separation', () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.updateMatrixWorld();
    const focal = 900 / (2 * Math.tan((75 * Math.PI) / 360));
    for (const surface of ['stone', 'wood', 'soft'] as const) {
      for (const distance of [10, 15, 25, 40]) {
        for (const random of [0, 0.5, 0.999]) {
          const d = new ImpactDebris();
          d.setView(camera, 900, false);
          d.burst({ x: 0, y: 0, z: -distance }, { x: 0, y: 0, z: 1 }, surface, () => random);
          advance(d, 16);
          const batch = spriteByName(d, 'fx:dust');
          const size = batch.geometry.getAttribute('aSize');
          const center = batch.geometry.getAttribute('aCenter');
          const px = (Math.max(size.getX(0), size.getY(0)) * focal) / -center.getZ(0);
          expect(px).toBeGreaterThanOrEqual(distance === 40 ? 40 : 70);
          if (distance !== 40) expect(px).toBeLessThanOrEqual(120);
          expect(spriteAlpha(batch)).toBeGreaterThanOrEqual(0.55);
        }
      }
    }
  });

  it('Low trims metal spark trails (half, shorter) but never removes them; the flash stays', () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.updateMatrixWorld();
    const sparksOf = (low: boolean): { trails: number; flashes: number; length: number } => {
      const d = new ImpactDebris();
      d.setView(camera, 900, low);
      d.burst({ x: 0, y: 0, z: -15 }, { x: 0, y: 0, z: 1 }, 'metal', seq());
      const storage = d as unknown as {
        glow: ImpactPool<{
          life: number;
          born: number;
          flash: boolean;
          ember?: boolean;
          sx: number;
        }>;
      };
      const live = storage.glow.slots.filter((p) => p.life > 0);
      const trails = live.filter((p) => !p.flash && !p.ember);
      return {
        trails: trails.length,
        flashes: live.filter((p) => p.flash).length,
        length: trails.reduce((a, p) => a + p.sx, 0) / Math.max(1, trails.length),
      };
    };
    const high = sparksOf(false);
    const low = sparksOf(true);
    expect(high.trails).toBeGreaterThanOrEqual(10);
    expect(low.trails).toBeGreaterThanOrEqual(1);
    expect(low.trails).toBeLessThanOrEqual(Math.ceil(high.trails * 0.5));
    expect(low.length).toBeLessThan(high.length * 0.8);
    expect(low.flashes).toBe(high.flashes);
  });

  it('hides rear impacts through foreground smoke while preserving front impacts in the same batch at every tier', () => {
    const smoke: SmokeCloud[] = [{ id: 1, pos: { x: 0, y: 0, z: -10 }, age: 2 }];
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.position.y = smokeShape(smoke[0]!).radius * 0.4;
    camera.updateMatrixWorld();
    for (const low of [false, true]) {
      const d = new ImpactDebris();
      d.setView(camera, 900, low);
      d.setSmoke(smoke);
      for (const z of [-5, -20]) {
        d.burst({ x: 0, y: camera.position.y, z }, { x: 0, y: 0, z: 1 }, 'metal', () => 0.5);
      }
      d.update(1 / 60);
      for (const name of ['fx:dust', 'fx:sparks'] as const) {
        const batch = spriteByName(d, name);
        const centers = batch.geometry.getAttribute('aCenter');
        let front = 0;
        let rear = 0;
        for (let i = 0; i < batch.geometry.instanceCount; i++) {
          if (centers.getZ(i) > -10) {
            expect(spriteAlpha(batch, i)).toBeGreaterThan(0);
            front++;
          } else {
            expect(spriteAlpha(batch, i)).toBe(0);
            rear++;
          }
        }
        expect(front).toBeGreaterThan(0);
        expect(rear).toBeGreaterThan(0);
      }
      d.setSmoke([]);
      d.update(1 / 60);
      expect(spriteAlpha(spriteByName(d, 'fx:sparks'), 1)).toBeGreaterThan(0);
    }
  });

  it('renders every new effect at least once even when a 22 fps frame exceeds its lifetime', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'metal', () => 0.5);
    // Force the short-duration edge case independently of the chosen presentation profile.
    const storage = d as unknown as {
      puffs: ImpactPool<{ life: number; max: number; born: number }>;
      glow: ImpactPool<{ life: number; max: number; born: number; flash: boolean }>;
    };
    for (const pool of [storage.puffs, storage.glow]) {
      for (const p of pool.slots) if (p.life > 0) p.life = p.max = 0.01;
    }
    d.update(1 / 22);
    expect(chipMesh(d).count).toBeGreaterThan(0);
    expect(spriteByName(d, 'fx:dust').geometry.instanceCount).toBeGreaterThan(0);
    const glow = spriteByName(d, 'fx:sparks');
    const flashIndex = storage.glow.slots.filter((p) => p.life > 0).findIndex((p) => p.flash);
    expect(flashIndex).toBeGreaterThanOrEqual(0);
    expect(spriteAlpha(glow, flashIndex)).toBeGreaterThan(0);
    d.update(1 / 22);
    expect(chipMesh(d).count).toBeGreaterThan(0); // chunks persist (they settle and stay)
    expect(spriteByName(d, 'fx:dust').geometry.instanceCount).toBe(0);
    expect(glow.geometry.instanceCount).toBe(0);
  });

  it('patches the stock billboard shader once and changes only uniforms for Low and resize', () => {
    const d = new ImpactDebris();
    const dust = spriteByName(d, 'fx:dust');
    const material = dust.material;
    const shader = {
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
      uniforms: {} as Record<string, { value: number }>,
    };
    material.onBeforeCompile(
      shader as unknown as Parameters<typeof material.onBeforeCompile>[0],
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).not.toContain('#include <project_vertex>');
    expect(shader.vertexShader).toContain('modelViewMatrix * vec4(aCenter, 1.0)');
    expect(shader.vertexShader).toContain('fxLimit / max(1.0, projected)');
    expect(shader.fragmentShader).toContain('0.24 * dot(vFxLight');
    const height = shader.uniforms.fxHeight;
    const limit = shader.uniforms.fxLimit;
    const key = material.customProgramCacheKey();
    const version = material.version;
    d.setView(new THREE.PerspectiveCamera(), 720, true);
    expect(shader.uniforms.fxHeight).toBe(height);
    expect(shader.uniforms.fxLimit).toBe(limit);
    expect(height!.value).toBe(720);
    expect(limit!.value).toBeCloseTo(720 * 0.22 * 0.8);
    expect(material.customProgramCacheKey()).toBe(key);
    expect(material.version).toBe(version);
    expect(material.side).toBe(THREE.FrontSide);
    expect(dust.renderOrder).toBe(0);
    expect(dust.geometry.getAttribute('color').itemSize).toBe(4);
  });

  it('retains the oldest-first recycling serial after effects render', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'metal', () => 0.5);
    const storage = d as unknown as {
      puffs: ImpactPool<{ life: number; born: number }>;
      glow: ImpactPool<{ life: number; born: number }>;
    };
    const pools = [storage.puffs, storage.glow];
    const serials = pools.map((pool) => pool.slots.map((p) => p.born));
    d.update(1 / 22);
    expect(pools.map((pool) => pool.slots.map((p) => p.born))).toEqual(serials);
  });

  it('reuses every particle record and GPU attribute across saturated multi-shooter bursts', () => {
    const d = new ImpactDebris();
    const storage = d as unknown as {
      puffs: ImpactPool<{ life: number; born: number }>;
      glow: ImpactPool<{ life: number; born: number }>;
    };
    const records = [d.chunks.slots, storage.puffs.slots, storage.glow.slots];
    const identities = records.map((slots) => new Set(slots));
    const dust = spriteByName(d, 'fx:dust');
    const glow = spriteByName(d, 'fx:sparks');
    const dustBuffer = dust.geometry.getAttribute('aCenter').array;
    const glowBuffer = glow.geometry.getAttribute('aSize').array;
    for (let i = 0; i < 300; i++) {
      d.burst({ x: i, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, i % 2 ? 'metal' : 'stone');
    }
    expect(d.chunks.slots).toBe(records[0]);
    expect(storage.puffs.slots).toBe(records[1]);
    expect(storage.glow.slots).toBe(records[2]);
    expect(new Set(d.chunks.slots)).toEqual(identities[0]);
    expect(new Set(storage.puffs.slots)).toEqual(identities[1]);
    expect(new Set(storage.glow.slots)).toEqual(identities[2]);
    d.update(1 / 60);
    expect(dust.geometry.getAttribute('aCenter').array).toBe(dustBuffer);
    expect(glow.geometry.getAttribute('aSize').array).toBe(glowBuffer);
  });

  it('kicks ground dust upward and Low trims puff count without removing it', () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.updateMatrixWorld();
    const high = new ImpactDebris();
    const low = new ImpactDebris();
    high.setView(camera, 900, false);
    low.setView(camera, 900, true);
    for (const d of [high, low]) {
      d.burst({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', () => 0.5);
      d.update(1 / 60);
    }
    const highDust = spriteByName(high, 'fx:dust');
    const lowDust = spriteByName(low, 'fx:dust');
    expect(highDust.geometry.getAttribute('aCenter').getY(0)).toBeGreaterThan(0.1);
    expect(lowDust.geometry.instanceCount).toBeGreaterThan(0);
    expect(lowDust.geometry.instanceCount).toBeLessThan(highDust.geometry.instanceCount);
    expect(lowDust.geometry.getAttribute('aSize').getX(0)).toBeLessThan(
      highDust.geometry.getAttribute('aSize').getX(0),
    );
  });

  it('tints puffs with current sun/sky colours while retaining a single additive spark material', () => {
    const d = new ImpactDebris();
    const sun = new THREE.DirectionalLight(new THREE.Color(1, 0.45, 0.12), 3);
    const sky = new THREE.HemisphereLight(
      new THREE.Color(0.5, 0.6, 1),
      new THREE.Color(0.2, 0.2, 0.2),
      0.5,
    );
    d.setLighting(sun, sky);
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'stone', () => 0.5);
    d.update(1 / 60);
    const color = spriteByName(d, 'fx:dust').geometry.getAttribute('color');
    expect(color.getX(0)).toBeGreaterThan(color.getZ(0));
    const mat = spriteMaterial(spriteByName(d, 'fx:sparks'));
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.toneMapped).toBe(false);
    expect(mat.fog).toBe(false);

    sun.color.setRGB(0.45, 0.6, 1);
    sun.intensity = 0.5;
    sky.color.setRGB(0.3, 0.5, 0.9);
    sky.intensity = 1;
    const rain = new ImpactDebris();
    rain.setLighting(sun, sky);
    rain.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'stone', () => 0.5);
    rain.update(1 / 60);
    const cool = spriteByName(rain, 'fx:dust').geometry.getAttribute('color');
    expect(cool.getZ(0)).toBeGreaterThan(cool.getX(0));
  });

  it('suppresses impact sprites hidden behind the same smoke used for concealment', () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.position.set(0, 1, 0);
    camera.updateMatrixWorld();
    const hidden = new ImpactDebris();
    hidden.setView(camera, 900, false);
    hidden.setSmoke([{ id: 1, pos: { x: 0, y: 0, z: -5 }, age: 2 }]);
    hidden.burst({ x: 0, y: 1, z: -10 }, { x: 0, y: 0, z: 1 }, 'metal', () => 0.5);
    hidden.update(1 / 60);

    const clear = new ImpactDebris();
    clear.setView(camera, 900, false);
    clear.burst({ x: 0, y: 1, z: -10 }, { x: 0, y: 0, z: 1 }, 'metal', () => 0.5);
    clear.update(1 / 60);

    expect(spriteAlpha(spriteByName(hidden, 'fx:sparks'))).toBeLessThan(0.05);
    expect(spriteAlpha(spriteByName(clear, 'fx:sparks'))).toBeGreaterThan(0.5);
  });

  it('makes metal streaks short-lived and gravity bends their reused velocity attribute', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'metal', () => 0.5);
    d.update(1 / 60);
    const sparks = spriteByName(d, 'fx:sparks');
    const velocity = sparks.geometry.getAttribute('aVelocity');
    const before = velocity.getY(0);
    const size = sparks.geometry.getAttribute('aSize');
    let longestRatio = 0;
    for (let i = 0; i < sparks.geometry.instanceCount; i++) {
      longestRatio = Math.max(longestRatio, size.getX(i) / size.getY(i));
    }
    expect(longestRatio).toBeGreaterThan(8);
    d.update(1 / 60);
    expect(velocity.getY(0)).toBeLessThan(before);
    advance(d, 24);
    expect(sparks.geometry.instanceCount).toBe(0);
  });

  it('draws a newly spawned metal flash for at least its first rendered frame at low fps', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'metal', () => 0.5);
    d.update(1 / 22);
    const sparks = spriteByName(d, 'fx:sparks');
    const size = sparks.geometry.getAttribute('aSize');
    let flashCount = 0;
    for (let i = 0; i < sparks.geometry.instanceCount; i++) {
      if (Math.abs(size.getX(i) - size.getY(i)) < 1e-6) flashCount++;
    }
    expect(flashCount).toBeGreaterThanOrEqual(1);
  });
  it('keeps solid chips as one lit instanced draw and two billboard batches for dust and sparks', () => {
    const d = new ImpactDebris();
    expect(d.group.children).toHaveLength(3);
    const chips = chipMesh(d);
    expect(chips.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(chips.instanceColor).toBeInstanceOf(THREE.InstancedBufferAttribute);
    expect(chips.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
    expect(chips.instanceColor!.usage).toBe(THREE.DynamicDrawUsage);
    // Vertex colours only where the geometry has them (else three multiplies by a missing 0).
    expect((chips.material as THREE.MeshStandardMaterial).vertexColors).toBe(
      chips.geometry.getAttribute('color') !== undefined,
    );
    expect(
      d.group.children.filter(
        (o) => o instanceof THREE.Mesh && o.geometry instanceof THREE.InstancedBufferGeometry,
      ),
    ).toHaveLength(2);
  });

  it('uses a separate mottled soft dust opacity texture instead of the spark dot', () => {
    const d = new ImpactDebris();
    const dust = spriteMaterial(spriteByName(d, 'fx:dust')).map as THREE.DataTexture;
    const spark = spriteMaterial(spriteByName(d, 'fx:sparks')).map as THREE.DataTexture;
    expect(dust).toBeInstanceOf(THREE.DataTexture);
    expect(spark).toBeInstanceOf(THREE.DataTexture);
    expect(dust).not.toBe(spark);
    expect(dust.image.width).toBe(64);
    expect(dust.image.height).toBe(64);
    expect(spark.image.width).toBe(32);
    expect(spark.image.height).toBe(32);

    const data = dust.image.data as Uint8Array;
    const alphaAt = (x: number, y: number): number => data[(y * 64 + x) * 4 + 3]!;
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(63, 0)).toBe(0);
    expect(alphaAt(0, 63)).toBe(0);
    expect(alphaAt(63, 63)).toBe(0);
    const center = [alphaAt(30, 30), alphaAt(31, 30), alphaAt(32, 31), alphaAt(33, 32)];
    for (const value of center) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(new Set(center).size).toBeGreaterThan(1);
    expect(data[(32 * 64 + 32) * 4]).toBeLessThan(data[(32 * 64 + 48) * 4]!);
  });

  it('fades dust in and out while keeping sparks on their existing texture', () => {
    const d = new ImpactDebris();
    const dustPoints = spriteByName(d, 'fx:dust');
    const sparkPoints = spriteByName(d, 'fx:sparks');
    const dustMap = spriteMaterial(dustPoints).map;
    const sparkMap = spriteMaterial(sparkPoints).map;

    d.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', () => 0.5);
    d.update(1 / 120);
    const early = spriteAlpha(dustPoints);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.08);

    advance(d, 14);
    const visible = spriteAlpha(dustPoints);
    expect(visible).toBeGreaterThan(early);
    expect(visible).toBeLessThanOrEqual(0.7);
    expect(visible).toBeGreaterThanOrEqual(0.55);

    advance(d, 46);
    const late = spriteAlpha(dustPoints);
    expect(late).toBeLessThan(visible);
    expect(spriteMaterial(dustPoints).map).toBe(dustMap);
    expect(spriteMaterial(sparkPoints).map).toBe(sparkMap);
  });

  it('starts randomized short and long dust lifetimes with the same early fade-in envelope', () => {
    for (const rnd of [() => 0, () => 0.999] as Array<() => number>) {
      const d = new ImpactDebris();
      const dustPoints = spriteByName(d, 'fx:dust');
      d.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', rnd);
      d.update(1 / 120);
      const early = spriteAlpha(dustPoints);
      expect(early).toBeGreaterThan(0);
      expect(early).toBeLessThan(0.08);
    }
  });

  it('does not grow debris draw resources across repeated dust updates', () => {
    const d = new ImpactDebris();
    const dustPoints = spriteByName(d, 'fx:dust');
    const sparkPoints = spriteByName(d, 'fx:sparks');
    const dustMap = spriteMaterial(dustPoints).map;
    const sparkMap = spriteMaterial(sparkPoints).map;
    for (let i = 0; i < 80; i++) {
      d.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', seq());
      d.update(1 / 60);
    }
    expect(d.group.children).toHaveLength(3);
    expect(spriteMaterial(dustPoints).map).toBe(dustMap);
    expect(spriteMaterial(sparkPoints).map).toBe(sparkMap);
    expect(dustPoints.geometry.instanceCount).toBeLessThanOrEqual(IMPACT_CAPACITY.puffs);
    expect(sparkPoints.geometry.instanceCount).toBeLessThanOrEqual(IMPACT_CAPACITY.glow);
  });

  it('exposes one off-screen warm-up chip without adding live particles', () => {
    const d = new ImpactDebris();
    const restore = d.beginWarmUp();
    const chips = chipMesh(d);
    expect(d.count).toBe(0);
    expect(d.collidableCount).toBe(0);
    expect(chips.count).toBe(1);
    expect(decomposeChip(d).pos.y).toBeCloseTo(-500, 5);

    restore();
    expect(d.count).toBe(0);
    expect(chips.count).toBe(0);
  });

  it('restores warm-up state from caller finally even when warm-up work throws', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'stone', () => 0.5);
    d.update(1 / 60);
    const before = decomposeChip(d);
    const beforeCount = chipMesh(d).count;
    const restore = d.beginWarmUp();
    try {
      throw new Error('compile failed');
    } catch {
      // The caller owns error handling; the important contract is that its finally can restore.
    } finally {
      restore();
    }
    const after = decomposeChip(d);
    expect(chipMesh(d).count).toBe(beforeCount);
    expect(after.pos.distanceTo(before.pos)).toBeLessThan(1e-6);
    expect(after.quat.dot(before.quat)).toBeCloseTo(1, 5);
    expect(after.scale.distanceTo(before.scale)).toBeLessThan(1e-6);
  });

  it('each surface throws its own kind of debris', () => {
    expect(DEBRIS.metal.sparks[0]).toBeGreaterThan(DEBRIS.stone.sparks[1]); // metal sparks
    expect(DEBRIS.stone.dust[0]).toBeGreaterThan(0); // stone puffs dust
    expect(DEBRIS.soft.decal).toBe(true); // a divot in the ground (ground hits only)
    expect(DEBRIS.wood.bits[0]).toBeGreaterThan(0); // splinters
  });

  it('is bounded: a long firefight never grows the pools past capacity', () => {
    const d = new ImpactDebris();
    const r = seq();
    for (let i = 0; i < 500; i++) d.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', r);
    expect(d.count).toBeLessThanOrEqual(
      IMPACT_CAPACITY.chips + IMPACT_CAPACITY.puffs + IMPACT_CAPACITY.glow,
    );
    expect(chipMesh(d).count).toBeLessThanOrEqual(IMPACT_CAPACITY.chips);
  });

  it('caps active world-collidable particles globally across repeated bursts', () => {
    const d = new ImpactDebris();
    const r = seq();
    for (let i = 0; i < 40; i++) {
      d.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'glass', r);
    }
    expect(d.collidableCount).toBeGreaterThan(80);
    expect(d.collidableCount).toBeLessThanOrEqual(96);
  });

  it('ignores invalid dt before changing particle life', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 'stone', seq());
    const count = d.count;
    d.update(Number.POSITIVE_INFINITY);
    expect(d.count).toBe(count);
  });

  it('opens a stone hit with a 2–3 frame hot flash and gravity-bent streak sparks', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'stone', () => 0.5);
    d.update(1 / 60);
    const sparks = spriteByName(d, 'fx:sparks');
    const size = sparks.geometry.getAttribute('aSize');
    const color = sparks.geometry.getAttribute('color');
    let flashes = 0;
    let streaks = 0;
    for (let i = 0; i < sparks.geometry.instanceCount; i++) {
      if (Math.abs(size.getX(i) - size.getY(i)) < 1e-6) flashes++;
      else if (size.getX(i) / size.getY(i) > 6) streaks++;
      expect(color.getX(i)).toBeGreaterThan(1); // hot
    }
    expect(flashes).toBe(2); // the hot core and its orange glow
    expect(streaks).toBeGreaterThanOrEqual(DEBRIS.stone.sparks[0]);
    advance(d, 2);
    const flashLeft = (): number => {
      let n = 0;
      for (let i = 0; i < sparks.geometry.instanceCount; i++) {
        if (Math.abs(size.getX(i) - size.getY(i)) < 1e-6) n++;
      }
      return n;
    };
    expect(flashLeft()).toBe(1); // third frame: the core still flashes, the glow is gone
    advance(d, 1);
    expect(flashLeft()).toBe(0); // gone by the fourth
    advance(d, 12);
    expect(sparks.geometry.instanceCount).toBe(0); // streaks are short
  });

  it('punches a dense darker kick jet out of the surface on the first frame, on every tier', () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 100);
    camera.position.set(0, 2, 5);
    camera.updateMatrixWorld();
    for (const low of [false, true]) {
      for (const surface of ['stone', 'wood', 'soft'] as const) {
        const d = new ImpactDebris();
        d.setView(camera, 900, low);
        d.burst({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, surface, () => 0.5);
        d.update(1 / 120);
        const dust = spriteByName(d, 'fx:dust');
        const n = dust.geometry.instanceCount;
        const kicks = DEBRIS[surface].kick;
        expect(n).toBeGreaterThan(kicks);
        const color = dust.geometry.getAttribute('color');
        const billow = 0;
        const kick = n - kicks; // the kick is acquired after the billow
        expect(color.getW(kick)).toBeGreaterThan(0.8);
        expect(color.getW(billow)).toBeLessThan(0.08);
        expect(color.getX(kick)).toBeLessThan(color.getX(billow)); // denser, darker
        const centers = dust.geometry.getAttribute('aCenter');
        const y0 = centers.getY(kick);
        advance(d, 6);
        expect(centers.getY(n - kicks)).toBeGreaterThan(y0 + 0.1); // thrown out of the ground
        advance(d, 30);
        // Gone in ~0.3 s; the billow stays.
        expect(dust.geometry.instanceCount).toBe(n - kicks);
      }
    }
  });

  it('makes glass shards glitter: twinkling glints that fall', () => {
    const d = new ImpactDebris();
    d.burst({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 'glass', () => 0.5);
    const sparks = spriteByName(d, 'fx:sparks');
    const storage = d as unknown as {
      glow: ImpactPool<{ life: number; born: number; twinkle: boolean }>;
    };
    expect(storage.glow.slots.filter((p) => p.life > 0 && p.twinkle).length).toBeGreaterThanOrEqual(
      DEBRIS.glass.embers[0],
    );
    const alphas = new Set<number>();
    for (let f = 0; f < 12; f++) {
      d.update(1 / 60);
      const last = sparks.geometry.instanceCount - 1;
      alphas.add(Math.round(spriteAlpha(sparks, last) * 20));
    }
    expect(alphas.size).toBeGreaterThan(3);
  });

  it('keeps flash, streaks and the dark kick readable on screen at 25 m without blowing up close', () => {
    const fov = 59;
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 200);
    camera.updateMatrixWorld();
    const focal = 720 / (2 * Math.tan((fov * Math.PI) / 360));
    const measure = (distance: number, low: boolean) => {
      const d = new ImpactDebris();
      d.setView(camera, 720, low);
      d.burst({ x: 0, y: 0, z: -distance }, { x: 0, y: 0, z: 1 }, 'stone', () => 0.5);
      d.update(1 / 60);
      const px = (name: 'fx:dust' | 'fx:sparks') => {
        const b = spriteByName(d, name);
        const size = b.geometry.getAttribute('aSize');
        const center = b.geometry.getAttribute('aCenter');
        return Array.from({ length: b.geometry.instanceCount }, (_, i) => ({
          x: (size.getX(i) * focal) / -center.getZ(i),
          y: (size.getY(i) * focal) / -center.getZ(i),
        }));
      };
      const glow = px('fx:sparks');
      const flashes = glow.filter((s) => Math.abs(s.x - s.y) < 1e-6).map((s) => s.x);
      const streaks = glow.filter((s) => s.x > s.y * 3);
      const dust = px('fx:dust');
      const kick = dust[dust.length - 1]!; // acquired after the billow
      return { flashes, streaks, kick };
    };
    for (const low of [false, true]) {
      const far = measure(25, low);
      expect(Math.min(...far.flashes)).toBeGreaterThanOrEqual(READ_PX.flashCore * 0.98);
      expect(Math.max(...far.flashes)).toBeGreaterThanOrEqual(READ_PX.flashGlow * 0.98);
      expect(far.streaks.length).toBeGreaterThan(0);
      for (const s of far.streaks) {
        // Streaks shrink slightly as they fade (growth 0.6–1).
        expect(s.x).toBeGreaterThanOrEqual(READ_PX.sparkLength * 0.7 * 0.6);
        expect(s.y).toBeGreaterThanOrEqual(READ_PX.sparkWidth * 0.6);
      }
      expect(far.kick.x).toBeGreaterThanOrEqual(READ_PX.kickLength * 0.7);
      expect(far.kick.y).toBeGreaterThanOrEqual(READ_PX.kickWidth * 0.7);
      // Close up the world sizes win: nothing balloons past the sprite screen cap.
      const near = measure(3, low);
      // (The billboard shader also clamps every sprite to `puffScreenLimit`.)
      expect(Math.max(...near.flashes)).toBeLessThanOrEqual(puffScreenLimit(false, 720) * 1.1);
      expect(Math.min(...near.flashes)).toBeLessThan(Math.min(...far.flashes) * 2.5);
    }
  });

  it('flashes metal and stone as a sharp star with a tight glow, not a glowing ball', () => {
    const fov = 59;
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 200);
    camera.updateMatrixWorld();
    const focal = 720 / (2 * Math.tan((fov * Math.PI) / 360));
    for (const surface of ['metal', 'stone'] as const) {
      for (const distance of [11, 25]) {
        const d = new ImpactDebris();
        d.setView(camera, 720, false);
        d.burst({ x: 0, y: 0, z: -distance }, { x: 0, y: 0, z: 1 }, surface, () => 0.5);
        const storage = d as unknown as {
          glow: ImpactPool<{
            life: number;
            born: number;
            flash: boolean;
            sx: number;
            sy: number;
            angle: number;
            r: number;
          }>;
        };
        const flashes = storage.glow.slots.filter((p) => p.life > 0 && p.flash);
        const discs = flashes.filter((p) => p.sx === p.sy);
        const rays = flashes.filter((p) => p.sx > p.sy * 6);
        expect(discs).toHaveLength(2); // the white disc and the orange glow
        expect(rays).toHaveLength(2);
        const [disc, glow] = [...discs].sort((a, b) => a.sx - b.sx);
        // The glow is orange (red-heavy) and only ~1.5× the disc, its floor ≤ 36 px at 25 m.
        expect(glow!.sx / disc!.sx).toBeGreaterThanOrEqual(1.4 - 1e-9);
        expect(glow!.sx / disc!.sx).toBeLessThanOrEqual(1.6 + 1e-9);
        if (distance === 25) expect((glow!.sx * focal) / distance).toBeLessThanOrEqual(36);
        // Two thin rays, unequal, crossing at roughly a right angle, longer than the disc.
        const [a, b] = rays;
        expect(Math.max(a!.sx, b!.sx)).toBeGreaterThan(disc!.sx * 1.5);
        expect(Math.min(a!.sx, b!.sx) / Math.max(a!.sx, b!.sx)).toBeCloseTo(0.7);
        const cross = Math.abs(Math.sin(a!.angle - b!.angle));
        expect(cross).toBeGreaterThan(0.9);
      }
    }
  });

  it('keeps every part of an oblique flash on one centre (core, rays and glow)', () => {
    const fov = 59;
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 200);
    camera.updateMatrixWorld();
    const n = Math.SQRT1_2;
    for (const surface of ['metal', 'stone', 'glass'] as const) {
      const d = new ImpactDebris();
      d.setView(camera, 720, false);
      // 45° to the view, ~7 m away.
      d.burst({ x: 0, y: 0, z: -7 }, { x: n, y: 0, z: n }, surface, () => 0.5);
      const storage = d as unknown as {
        glow: ImpactPool<{
          life: number;
          born: number;
          flash: boolean;
          x: number;
          y: number;
          z: number;
        }>;
      };
      const flashes = storage.glow.slots.filter((p) => p.life > 0 && p.flash);
      expect(flashes.length).toBeGreaterThan(0);
      for (const p of flashes) {
        expect(p.x).toBeCloseTo(flashes[0]!.x, 9);
        expect(p.y).toBeCloseTo(flashes[0]!.y, 9);
        expect(p.z).toBeCloseTo(flashes[0]!.z, 9);
      }
    }
    expect(flashClearance(0.2, 1, 0.5)).toBeCloseTo(0.52);
    expect(flashClearance(4)).toBe(0.6);
  });

  it('keeps flying chunks readable at 25 m (≥ 6 px at 720p) and lands them at true size', () => {
    const fov = 59;
    const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.1, 200);
    camera.updateMatrixWorld();
    const ppm = 720 / (2 * Math.tan((fov * Math.PI) / 360)) / 25;
    for (const surface of ['stone', 'metal', 'wood', 'glass'] as const) {
      const d = new ImpactDebris();
      d.setView(camera, 720, false);
      d.burst({ x: 0, y: 2, z: -25 }, { x: 0, y: 0, z: 1 }, surface, seq());
      d.update(1 / 60);
      const live = d.chunks.slots.filter((c) => c.life > 0);
      expect(live.length).toBeGreaterThan(0);
      for (const c of live) {
        const shown = 2 * Math.max(c.sx, c.sy, c.sz) * c.grow;
        expect(shown * ppm).toBeGreaterThanOrEqual(READ_PX.chip - 1e-6);
        // Physical size for collision and rest (the growth is flight-only).
        expect(c.radius).toBeLessThan(0.05);
        expect(chunkDrawScale({ ...c, settled: true, rest: 1, life: 30 })).toBe(1);
      }
    }
  });
});
