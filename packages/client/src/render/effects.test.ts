import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DECAL_GAIN,
  DECAL_JITTER,
  DECAL_MATERIALS,
  DECAL_SIZE,
  DECAL_TILE_COUNT,
  DECAL_TILE_PX,
  DECAL_VARIANTS,
  decalModulate,
  decalTexel,
  decalWorldSize,
} from './decalAtlas.ts';
import {
  Effects,
  decalFogFragment,
  decalLift,
  foggedDecalFactor,
  impactDecalAtlasTexture,
  WALL_DECAL_OFFSET,
} from './effects.ts';
import { OVER_FLATS } from './mapMesh.ts';
import { SmokeView } from './tacticalFx.ts';

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
        fillStyle: '',
      }),
    }),
  });
});

describe('combat effects', () => {
  function decals(fx: Effects): THREE.InstancedMesh {
    const mesh = fx.group.children.find(
      (o): o is THREE.InstancedMesh =>
        o instanceof THREE.InstancedMesh && o.name === 'fx:impact-decals',
    );
    if (!mesh) throw new Error('missing impact decal mesh');
    return mesh;
  }

  function decalTile(mesh: THREE.InstancedMesh): THREE.InstancedBufferAttribute {
    return mesh.geometry.getAttribute('decalTile') as THREE.InstancedBufferAttribute;
  }

  function instancedBatchByName(
    fx: Effects,
    name: string,
  ): THREE.Mesh<THREE.InstancedBufferGeometry> {
    const mesh = fx.debris.group.children.find(
      (o): o is THREE.Mesh<THREE.InstancedBufferGeometry> =>
        o instanceof THREE.Mesh &&
        o.name === name &&
        o.geometry instanceof THREE.InstancedBufferGeometry,
    );
    if (!mesh) throw new Error(`missing ${name}`);
    return mesh;
  }

  function decalMaterial(fx: Effects): THREE.MeshBasicMaterial {
    return decals(fx).material as THREE.MeshBasicMaterial;
  }

  it('an airborne blast shows fire and smoke without creating a floating scorch or stone chips', () => {
    const fx = new Effects();
    fx.explosion({ x: 0, y: 8, z: 0 });
    expect(fx.debris.count).toBe(0);
    expect(fx.group.children.some((o) => o.name === 'fx:blast-scorch' && o.visible)).toBe(false);
    expect(fx.group.children.some((o) => o instanceof THREE.Sprite && o.visible)).toBe(true);
  });
  it('uses the explosion contact surface for debris and aligns scorch to the hit normal', () => {
    const fx = new Effects();
    fx.explosion(
      { x: 0, y: 1, z: 0 },
      {
        point: { x: 2, y: 1, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
        surface: 'metal',
      },
    );

    expect(fx.debris.count).toBeGreaterThanOrEqual(12);
    const scorch = fx.group.children.find(
      (o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === 'fx:blast-scorch' && o.visible,
    );
    expect(scorch).toBeDefined();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(scorch!.quaternion);
    expect(normal.x).toBeCloseTo(1, 5);
    expect(scorch!.position.x).toBeGreaterThan(2);
  });

  it('builds one atlas of irregular variants per surface with a dark core and a lighter rim', () => {
    const tex = impactDecalAtlasTexture();
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex.image.width).toBe(DECAL_TILE_PX * DECAL_TILE_COUNT);
    expect(tex.image.height).toBe(DECAL_TILE_PX);
    expect(DECAL_TILE_COUNT).toBe(DECAL_MATERIALS.length * DECAL_VARIANTS);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.colorSpace).toBe(THREE.SRGBColorSpace);
    const lum = (t: number[]): number => (t[0]! + t[1]! + t[2]!) / 3;
    for (const surface of DECAL_MATERIALS) {
      for (let v = 0; v < DECAL_VARIANTS; v++) {
        const core = decalTexel(surface, v, 0.5, 0.5);
        expect(lum(core)).toBeLessThan(45); // near-black hole
        expect(core[3]).toBeGreaterThan(200);
        // The edge of the tile is clear (the decal never shows its square).
        for (const [u, w] of [
          [0.01, 0.5],
          [0.99, 0.5],
          [0.5, 0.01],
          [0.5, 0.99],
        ] as const) {
          expect(decalTexel(surface, v, u, w)[3]).toBeLessThan(40);
        }
      }
      // Variants differ, and the outline is not a circle: coverage on a ring varies by angle.
      const ring = (v: number): number[] =>
        Array.from({ length: 24 }, (_, k) => {
          const a = (k / 24) * Math.PI * 2;
          return decalTexel(surface, v, 0.5 + Math.cos(a) * 0.3, 0.5 + Math.sin(a) * 0.3)[3];
        });
      expect(ring(0)).not.toEqual(ring(1));
      if (surface !== 'glass' && surface !== 'metal') {
        expect(Math.max(...ring(0)) - Math.min(...ring(0))).toBeGreaterThan(20);
      }
    }
    // Lighter than the hole round it: fresh spall (stone), bare metal, pale fibres, frosted glass.
    const rimMax = (
      surface: (typeof DECAL_MATERIALS)[number],
      from: number,
      to: number,
    ): number => {
      let best = 0;
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        for (let r = from; r <= to; r += 0.02) {
          const t = decalTexel(
            surface,
            0,
            0.5 + (Math.cos(a) * r) / 2,
            0.5 + (Math.sin(a) * r) / 2,
          );
          if (t[3] > 100) best = Math.max(best, lum(t));
        }
      }
      return best;
    };
    expect(rimMax('stone', 0.4, 0.62)).toBeGreaterThan(150);
    expect(rimMax('metal', 0.28, 0.46)).toBeGreaterThan(150);
    expect(rimMax('wood', 0.2, 0.6)).toBeGreaterThan(110);
    expect(rimMax('glass', 0.12, 0.6)).toBeGreaterThan(190);
  });
  it('keeps every bullet hole at its physical size, from 3 m or 40 m alike', () => {
    const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 200);
    camera.updateMatrixWorld();
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const orientation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const surface of ['stone', 'wood', 'metal', 'glass'] as const) {
      for (const distance of [3, 40]) {
        const fx = new Effects();
        fx.setImpactView(camera, 720, false);
        for (const random of [0, 0.5, 0.999]) {
          const rng = vi.spyOn(Math, 'random').mockReturnValue(random);
          try {
            fx.impact({ x: 0, y: 0, z: -distance }, { x: 0, y: 0, z: 1 }, surface, false);
          } finally {
            rng.mockRestore();
          }
          const mesh = decals(fx);
          mesh.getMatrixAt(mesh.count - 1, matrix);
          matrix.decompose(position, orientation, scale);
          expect(scale.x).toBeCloseTo(
            DECAL_SIZE[surface] * (1 - DECAL_JITTER / 2 + random * DECAL_JITTER),
            6,
          );
        }
      }
    }
    // Rifle-round sizes: a stone spall crater of ~6–12 cm, metal/wood holes a few cm overall.
    expect(DECAL_SIZE.stone * 0.8 * 0.62).toBeGreaterThan(0.06);
    expect(DECAL_SIZE.stone * 1.2 * 0.66).toBeLessThan(0.12);
    expect(DECAL_SIZE.metal).toBeLessThan(0.06);
    expect(DECAL_SIZE.wood).toBeLessThan(0.08);
  });
  it('lifts a bullet hole onto presentation dressing over the collision face', () => {
    const fx = new Effects();
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const point = { x: 2, y: 1, z: -3 };
    const normal = { x: 0, y: 0, z: 1 };
    fx.impact(point, normal, 'stone', false);
    decals(fx).getMatrixAt(0, matrix);
    expect(at.setFromMatrixPosition(matrix).z).toBeCloseTo(-3 + 0.004, 6);
    const seen: unknown[] = [];
    fx.setDecalLift((p, n) => {
      seen.push(p, n);
      return 0.042; // a roller shutter 42 mm off the wall
    });
    fx.impact(point, normal, 'stone', false);
    decals(fx).getMatrixAt(1, matrix);
    at.setFromMatrixPosition(matrix);
    expect(at.z).toBeCloseTo(-3 + 0.046, 6);
    expect([at.x, at.y]).toEqual([2, 1]);
    expect(seen).toEqual([point, normal]);
  });

  it('lifts ground holes to the higher of the flats clearance and the skin, never their sum', () => {
    const fx = new Effects();
    const ground = fx.group.getObjectByName('fx:impact-decals-ground') as THREE.InstancedMesh;
    const wall = decals(fx);
    const matrix = new THREE.Matrix4();
    const at = new THREE.Vector3();
    const up = { x: 0, y: 1, z: 0 };
    let skin = 0.004; // the hall's terrazzo, 4 mm over the map floor
    fx.setDecalLift(() => skin);
    fx.impact({ x: 0, y: 0.05, z: 0 }, up, 'stone', false);
    ground.getMatrixAt(0, matrix);
    expect(at.setFromMatrixPosition(matrix).y).toBeCloseTo(0.05 + OVER_FLATS.lift, 6);
    skin = 0.05; // a skin taller than the clearance: the hole sits on it
    fx.impact({ x: 0, y: 1, z: 0 }, up, 'stone', false);
    ground.getMatrixAt(1, matrix);
    expect(at.setFromMatrixPosition(matrix).y).toBeCloseTo(1 + 0.054, 6);
    expect(ground.count).toBe(2);
    expect(wall.count).toBe(0); // up-facing hits stay in the ground batch
  });

  it('keeps impact sprites in transparent depth sorting with SmokeView concealment', () => {
    const fx = new Effects();
    const smoke = new SmokeView();
    smoke.update(0, [{ id: 1, pos: { x: 0, y: 0, z: 0 }, age: 1 }], 0);
    const smokeSprite = smoke.group.children[0]!.children[0] as THREE.Sprite;
    const dust = instancedBatchByName(fx, 'fx:dust');
    const sparks = instancedBatchByName(fx, 'fx:sparks');

    expect(smokeSprite.material.depthWrite).toBe(false);
    expect((dust.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
    expect((sparks.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
    expect(dust.renderOrder).toBe(smokeSprite.renderOrder);
    expect(sparks.renderOrder).toBe(smokeSprite.renderOrder);
  });

  it('keeps one instanced decal draw, caps at 160, and records atlas variants per surface', () => {
    const fx = new Effects();
    const mesh = decals(fx);
    const tiles = decalTile(mesh);
    const texture = (mesh.material as THREE.MeshBasicMaterial).map;
    const matrix = mesh.instanceMatrix;

    fx.impact({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 'stone', false);
    fx.impact({ x: 1, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 'metal', false);
    fx.impact({ x: 2, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 'wood', false);
    fx.impact({ x: 3, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 'glass', false);
    fx.impact({ x: 4, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 'soft', false);

    // A soft wall face (hedge, sandbag) keeps no divot: only ground hits do.
    expect(mesh.count).toBe(4);
    expect([0, 1, 2, 3].map((i) => Math.floor(tiles.getX(i) / DECAL_VARIANTS))).toEqual([
      0, 1, 2, 3,
    ]);
    expect(fx.debris.count).toBe(0);

    for (let i = 0; i < 180; i++) {
      fx.impact({ x: i, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 'stone', false);
    }
    expect(mesh.count).toBe(160);
    expect(mesh.geometry.getAttribute('decalTile')).toBe(tiles);
    expect(mesh.instanceMatrix).toBe(matrix);
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBe(texture);
  });

  it('keeps three map UV setup and remaps vMapUv to the atlas tile', () => {
    const mat = decalMaterial(new Effects());
    const shader = {
      uniforms: {},
      vertexShader:
        '#include <common>\nvoid main() {\n#include <uv_vertex>\n#include <begin_vertex>\n}',
      fragmentShader: '',
    };

    mat.onBeforeCompile(
      shader as unknown as Parameters<NonNullable<typeof mat.onBeforeCompile>>[0],
      {} as THREE.WebGLRenderer,
    );

    expect(shader.vertexShader).toContain('attribute float decalTile;');
    expect(shader.vertexShader).toContain('#include <uv_vertex>');
    expect(shader.vertexShader).toContain('#ifdef USE_MAP');
    expect(shader.vertexShader).toContain('vMapUv.x = clamp(');
    expect(shader.vertexShader).toContain((0.5 / (DECAL_TILE_PX * DECAL_TILE_COUNT)).toFixed(8));
    expect(shader.vertexShader).not.toContain('vUv = vec2((uv.x + decalTile)');
  });

  it('varies a hole by ±20 % and by variant, never by distance', () => {
    for (const surface of DECAL_MATERIALS) {
      expect(decalWorldSize(surface, () => 0)).toBeCloseTo(DECAL_SIZE[surface] * 0.8);
      expect(decalWorldSize(surface, () => 0.5)).toBeCloseTo(DECAL_SIZE[surface]);
      expect(decalWorldSize(surface, () => 1)).toBeCloseTo(DECAL_SIZE[surface] * 1.2);
    }
    const fx = new Effects();
    const ground = fx.group.getObjectByName('fx:impact-decals-ground') as THREE.InstancedMesh;
    const tiles = ground.geometry.getAttribute('decalTile');
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      fx.impact({ x: i, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 'soft', false);
      seen.add(tiles.getX(i));
    }
    // Every lawn hit is one of the soft divot's variants.
    expect([...seen].every((t) => Math.floor(t / DECAL_VARIANTS) === 4)).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });
  it('warms decal, chip, dust, and spark batches, then restores the pools', () => {
    const fx = new Effects();
    const mesh = decals(fx);
    const dust = instancedBatchByName(fx, 'fx:dust');
    const sparks = instancedBatchByName(fx, 'fx:sparks');

    const restore = fx.beginWarmUp();
    expect(mesh.count).toBe(1);
    expect(dust.geometry.instanceCount).toBe(1);
    expect(sparks.geometry.instanceCount).toBe(1);
    expect(fx.debris.count).toBe(0);

    restore();
    expect(mesh.count).toBe(0);
    expect(dust.geometry.instanceCount).toBe(0);
    expect(sparks.geometry.instanceCount).toBe(0);
    expect(fx.debris.count).toBe(0);
  });

  it('does not add impact materials or draw resources after warm-up', async () => {
    const fx = new Effects();
    const renderer = new ImpactResourceRecorder();
    const camera = new THREE.PerspectiveCamera();

    const restore = fx.beginWarmUp();
    await renderer.compileAsync(fx.group, camera);
    renderer.render(fx.group, camera);
    // Wall + ground decals + chunk chips + splinters + dust sprites + additive sparks.
    expect(renderer.draws).toBe(6);
    // Both decal batches share one program (only their depth bias, GL state, differs).
    expect(
      new Set(renderer.materialKeys().filter((k) => k.startsWith('fx:impact-decal'))).size,
    ).toBe(1);
    const warmedKeys = renderer.materialKeys();
    restore();

    for (const surface of ['stone', 'metal', 'wood', 'glass', 'soft'] as const) {
      fx.impact({ x: 1, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, surface);
      fx.impact({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, surface);
    }
    for (let i = 0; i < 12; i++) fx.update(1 / 60);

    renderer.reset();
    renderer.render(fx.group, camera);
    expect(renderer.materialKeys()).toEqual(warmedKeys);
    expect(renderer.draws).toBeLessThanOrEqual(6);
  });

  it('forwards impact view and lighting to the typed debris batch', () => {
    const fx = new Effects();
    const setView = vi.spyOn(fx.debris, 'setView');
    const setLighting = vi.spyOn(fx.debris, 'setLighting');
    const setSmoke = vi.spyOn(fx.debris, 'setSmoke');
    const camera = new THREE.PerspectiveCamera();
    const sun = new THREE.DirectionalLight();
    const hemi = new THREE.HemisphereLight();
    const smoke = [{ id: 1, pos: { x: 0, y: 0, z: 0 }, age: 2 }];

    fx.setImpactView(camera, 900, true, smoke);
    fx.setImpactLighting(sun, hemi);

    expect(setView).toHaveBeenCalledWith(camera, 900, true);
    expect(setSmoke).toHaveBeenCalledWith(smoke);
    expect(setLighting).toHaveBeenCalledWith(sun, hemi);
  });

  it('lays ground holes and scorches over the paving flats (they used to hide under them)', () => {
    expect(decalLift({ x: 0, y: 1, z: 0 })).toBe(OVER_FLATS.lift);
    expect(decalLift({ x: 0, y: 0, z: 1 })).toBeLessThan(0.01);
    const fx = new Effects();
    const ground = fx.group.getObjectByName('fx:impact-decals-ground') as THREE.InstancedMesh;
    const groundMat = ground.material as THREE.MeshBasicMaterial;
    expect(groundMat.polygonOffsetFactor).toBe(OVER_FLATS.factor);
    expect(groundMat.polygonOffsetUnits).toBe(OVER_FLATS.units);
    // Walls and props keep the small bias: the ground's would pull a far decal ~20 cm forward,
    // through whatever stands just in front of the wall.
    const wallMat = decalMaterial(fx);
    expect(wallMat.polygonOffsetFactor).toBe(WALL_DECAL_OFFSET.factor);
    expect(wallMat.polygonOffsetUnits).toBe(WALL_DECAL_OFFSET.units);
    expect(wallMat.customProgramCacheKey()).toBe(groundMat.customProgramCacheKey());
    expect(wallMat.map).toBe(groundMat.map);

    fx.impact({ x: 1, y: 0, z: 2 }, { x: 0, y: 1, z: 0 }, 'stone', false);
    fx.impact({ x: 1, y: 1, z: 2 }, { x: 0, y: 0, z: 1 }, 'stone', false);
    expect(ground.count).toBe(1);
    expect(decals(fx).count).toBe(1);
    const m = new THREE.Matrix4();
    ground.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).y).toBeCloseTo(OVER_FLATS.lift);
    decals(fx).getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).z).toBeCloseTo(2.004);

    // Scorches pick the bias by surface too.
    fx.explosion(
      { x: 0, y: 0.3, z: 0 },
      { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, surface: 'stone' },
    );
    fx.explosion(
      { x: 0, y: 1, z: 0 },
      { point: { x: 0, y: 1, z: -1 }, normal: { x: 0, y: 0, z: 1 }, surface: 'stone' },
    );
    const scorches = fx.group.children.filter(
      (o): o is THREE.Mesh => o instanceof THREE.Mesh && o.name === 'fx:blast-scorch' && o.visible,
    );
    expect(scorches.map((o) => (o.material as THREE.Material).polygonOffsetFactor)).toEqual([
      OVER_FLATS.factor,
      WALL_DECAL_OFFSET.factor,
    ]);
  });

  it('multiplies the surface under a hole (relative spall, not white paint), one program', () => {
    // Factors: the hole near-black, spall/bare metal/fibres lighter than the surface (≤ gain),
    // untouched (1) at the edge of the quad.
    for (const surface of DECAL_MATERIALS) {
      const core = decalModulate(decalTexel(surface, 0, 0.5, 0.5));
      expect(Math.max(...core)).toBeLessThan(0.12);
      for (const f of decalModulate(decalTexel(surface, 0, 0.01, 0.5))) expect(f).toBeCloseTo(1, 2);
    }
    const lightest = (surface: (typeof DECAL_MATERIALS)[number]): number => {
      let best = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const f = decalModulate(decalTexel(surface, 0, x / 32, y / 32));
          best = Math.max(best, (f[0] + f[1] + f[2]) / 3);
        }
      }
      return best;
    };
    for (const surface of ['stone', 'metal', 'wood', 'glass'] as const) {
      expect(lightest(surface)).toBeGreaterThan(1.1);
      expect(lightest(surface)).toBeLessThanOrEqual(DECAL_GAIN + 1e-9);
    }
    // A neutral grey factor: a decal never tints the surface's hue on its own.
    const rim = decalModulate([200, 200, 200, 255]);
    expect(rim[0]).toBeCloseTo(rim[1]);

    const fx = new Effects();
    for (const mesh of [
      decals(fx),
      fx.group.getObjectByName('fx:impact-decals-ground') as THREE.InstancedMesh,
    ]) {
      const mat = mesh.material as THREE.MeshBasicMaterial;
      expect(mat.blending).toBe(THREE.CustomBlending);
      expect(mat.blendSrc).toBe(THREE.ZeroFactor);
      expect(mat.blendDst).toBe(THREE.SrcColorFactor);
      expect(mat.fog).toBe(true); // fogged toward 1, see the fog test
      expect(mat.toneMapped).toBe(false);
      expect(mat.color.r).toBeCloseTo(DECAL_GAIN);
    }
    // The packed atlas: neutral texels store 1 / gain (sRGB), so the material's gain restores 1.
    const data = impactDecalAtlasTexture().image.data as Uint8Array;
    const neutral = Math.round((1.055 * (1 / DECAL_GAIN) ** (1 / 2.4) - 0.055) * 255);
    expect(data[0]).toBe(neutral);
    expect(data[3]).toBe(255);
  });

  it('fades a hole into fog with its surface: the factor goes to 1, not to the fog colour', () => {
    expect(foggedDecalFactor(0.05, 0)).toBeCloseTo(0.05);
    expect(foggedDecalFactor(0.05, 1)).toBe(1);
    expect(foggedDecalFactor(0.05, 0.5)).toBeCloseTo(0.525);
    expect(foggedDecalFactor(1.3, 0.5)).toBeCloseTo(1.15);
    const chunk = decalFogFragment();
    expect(chunk).not.toContain('fogColor');
    expect(chunk).toContain('vec3( 1.0 )');
    expect(chunk).toContain('fogFactor');
    const mat = decalMaterial(new Effects());
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    mat.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.fragmentShader).not.toContain('#include <fog_fragment>');
    expect(shader.fragmentShader).toContain(chunk);
  });

  it('draws nothing after the warm-up is restored (no stray warm-up instance in the world)', () => {
    const fx = new Effects();
    fx.beginWarmUp()();
    fx.update(0, []);
    fx.update(1 / 60, []);
    const drawn: string[] = [];
    fx.group.traverse((o) => {
      let visible = true;
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) visible = false;
      if (!visible) return;
      if (o instanceof THREE.InstancedMesh) {
        if (o.count > 0) drawn.push(o.name);
      } else if (o instanceof THREE.Mesh && o.geometry instanceof THREE.InstancedBufferGeometry) {
        if (o.geometry.instanceCount > 0) drawn.push(o.name);
      } else if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) drawn.push(o.name);
    });
    expect(drawn).toEqual([]);
  });
});

class ImpactResourceRecorder {
  readonly materials = new Set<THREE.Material>();
  draws = 0;

  compileAsync(root: THREE.Object3D, _camera: THREE.Camera): Promise<void> {
    this.record(root, false);
    return Promise.resolve();
  }

  render(root: THREE.Object3D, _camera: THREE.Camera): void {
    this.record(root, true);
  }

  reset(): void {
    this.draws = 0;
  }

  materialKeys(): string[] {
    return [...this.materials].map((mat) => `${mat.name}:${mat.customProgramCacheKey()}`).sort();
  }

  private record(root: THREE.Object3D, countDraws: boolean): void {
    root.traverse((o) => {
      if (!isImpactDraw(o)) return;
      const mat = materialOf(o);
      if (mat) this.materials.add(mat);
      if (countDraws && hasInstances(o)) this.draws++;
    });
  }
}

function isImpactDraw(o: THREE.Object3D): boolean {
  return (
    o.name === 'fx:impact-decals' ||
    o.name === 'fx:impact-decals-ground' ||
    o.name === 'fx:debris-chips' ||
    o.name === 'fx:debris-splinters' ||
    o.name === 'fx:dust' ||
    o.name === 'fx:sparks'
  );
}

function materialOf(o: THREE.Object3D): THREE.Material | null {
  if (!(o instanceof THREE.Mesh)) return null;
  const material = o.material as THREE.Material | THREE.Material[];
  return Array.isArray(material) ? (material[0] ?? null) : material;
}

function hasInstances(o: THREE.Object3D): boolean {
  if (o instanceof THREE.InstancedMesh) return o.count > 0;
  if (o instanceof THREE.Mesh && o.geometry instanceof THREE.InstancedBufferGeometry) {
    const geometry = o.geometry;
    return geometry.instanceCount > 0;
  }
  return false;
}
