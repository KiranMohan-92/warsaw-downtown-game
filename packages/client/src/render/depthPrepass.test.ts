import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DepthPrepass, PREPASS_LAYER, prepassEligible, prepassGroup } from './depthPrepass.ts';

const box = new THREE.BoxGeometry();
function mesh(
  name: string,
  material: THREE.Material | THREE.Material[] = new THREE.MeshStandardMaterial(),
) {
  const m = new THREE.Mesh(box, material);
  m.name = name;
  return m;
}

describe('depth pre-pass eligibility', () => {
  it('takes the static opaque map and facades', () => {
    expect(prepassEligible(mesh('map:facade|256:0,-1|stone|0'))).toBe(true);
    expect(prepassEligible(mesh('facade:shell'))).toBe(true);
    expect(prepassEligible(mesh('map:x', new THREE.MeshLambertMaterial()))).toBe(true);
  });

  it('names come from the nearest named ancestor', () => {
    const g = new THREE.Group();
    g.name = 'facade:near';
    const child = mesh('');
    g.add(child);
    expect(prepassGroup(child)).toBe('facade');
    expect(prepassEligible(child)).toBe(true);
  });

  it('takes both levels of a map LOD (sandbag chunks: bags near, box far; static world geometry)', () => {
    const lod = new THREE.LOD();
    lod.name = 'map:sandbags:3,-2';
    const near = mesh('');
    const far = mesh('');
    lod.addLevel(near, 0);
    lod.addLevel(far, 40);
    expect(prepassEligible(near)).toBe(true);
    expect(prepassEligible(far)).toBe(true);
    // Instanced grass and hedge sprigs (vertex sway/shrink) live under foliage: still out.
    const blades = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial(), 4);
    blades.name = 'foliage:grass';
    expect(prepassEligible(blades)).toBe(false);
  });

  it('leaves out displaced, skinned and discarding geometry (foliage, trees, soldiers)', () => {
    expect(prepassEligible(mesh('foliage:core'))).toBe(false);
    expect(prepassEligible(mesh('trees'))).toBe(false);
    expect(prepassEligible(mesh('props:crate'))).toBe(false); // measured cheaper without
    const skinned = new THREE.SkinnedMesh(box, new THREE.MeshStandardMaterial());
    skinned.name = 'map:soldier';
    expect(prepassEligible(skinned)).toBe(false);
    const morph = new THREE.BoxGeometry();
    morph.morphAttributes.position = [morph.attributes.position as THREE.BufferAttribute];
    const morphing = new THREE.Mesh(morph, new THREE.MeshStandardMaterial());
    morphing.name = 'map:morph';
    expect(prepassEligible(morphing)).toBe(false);
  });

  it('leaves out materials whose depth the pre-pass would not reproduce', () => {
    const bad: THREE.Material[] = [
      new THREE.MeshStandardMaterial({ transparent: true }),
      new THREE.MeshStandardMaterial({ alphaTest: 0.5 }),
      new THREE.MeshStandardMaterial({ alphaHash: true }),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }), // shadow proxy
      new THREE.MeshStandardMaterial({ depthWrite: false }),
      new THREE.MeshStandardMaterial({ side: THREE.BackSide }),
      new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: 2 }),
      new THREE.MeshStandardMaterial({ displacementMap: new THREE.Texture() }),
      new THREE.MeshDepthMaterial(),
      new THREE.ShaderMaterial(),
    ];
    for (const m of bad) expect(prepassEligible(mesh('map:x', m))).toBe(false);
    // Pulled forward (ground markings) is fine: the shaded draw still passes LessEqual.
    const marking = new THREE.MeshStandardMaterial({
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -6,
    });
    expect(prepassEligible(mesh('map:marking', marking))).toBe(true);
    expect(
      prepassEligible(
        mesh('map:double', new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })),
      ),
    ).toBe(true);
  });

  it('a multi-material mesh qualifies only if every material does', () => {
    const ok = new THREE.MeshStandardMaterial();
    expect(prepassEligible(mesh('map:x', [ok, ok]))).toBe(true);
    expect(
      prepassEligible(mesh('map:x', [ok, new THREE.MeshStandardMaterial({ transparent: true })])),
    ).toBe(false);
  });
});

describe('DepthPrepass', () => {
  function world() {
    const scene = new THREE.Scene();
    const wall = mesh('map:wall');
    const bush = mesh('foliage:core');
    scene.add(wall, bush);
    return { scene, wall, bush };
  }

  it('tags eligible meshes with its layer (and untags on refresh), main layer untouched', () => {
    const { scene, wall, bush } = world();
    const p = new DepthPrepass();
    expect(p.refresh(scene)).toBe(1);
    expect(wall.layers.isEnabled(PREPASS_LAYER)).toBe(true);
    expect(wall.layers.isEnabled(0)).toBe(true);
    expect(bush.layers.isEnabled(PREPASS_LAYER)).toBe(false);
    wall.material = new THREE.MeshStandardMaterial({ transparent: true });
    expect(p.refresh(scene)).toBe(0);
    expect(wall.layers.isEnabled(PREPASS_LAYER)).toBe(false);
  });

  it('draws depth only, pushed back, and restores camera, override and shadow state', () => {
    const { scene } = world();
    const p = new DepthPrepass();
    p.refresh(scene);
    expect(p.material.colorWrite).toBe(false);
    expect(p.material.polygonOffset).toBe(true);
    expect(p.material.polygonOffsetFactor).toBeGreaterThan(0);
    const camera = new THREE.PerspectiveCamera();
    const seen: { mask: number; override: THREE.Material | null; autoUpdate: boolean }[] = [];
    const renderer = {
      shadowMap: { autoUpdate: true },
      render: vi.fn((s: THREE.Scene, c: THREE.Camera) =>
        seen.push({
          mask: c.layers.mask,
          override: s.overrideMaterial,
          autoUpdate: renderer.shadowMap.autoUpdate,
        }),
      ),
    };
    p.render(renderer as unknown as THREE.WebGLRenderer, scene, camera);
    expect(seen).toEqual([{ mask: 1 << PREPASS_LAYER, override: p.material, autoUpdate: false }]);
    expect(camera.layers.mask).toBe(1);
    expect(scene.overrideMaterial).toBeNull();
    expect(renderer.shadowMap.autoUpdate).toBe(true);
    p.enabled = false;
    p.render(renderer as unknown as THREE.WebGLRenderer, scene, camera);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});
