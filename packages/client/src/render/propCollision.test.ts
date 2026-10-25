import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  crate,
  DECOR_KINDS,
  initPhysics,
  jersey,
  PhysicsWorld,
  type MapDefinition,
} from '@wd/shared';
import { measureSizes, validatePropGeometry } from './propModels.ts';
import { fitBox, fitDecor, PROP_MODEL_IDS } from './propFit.ts';
import { buildMapMeshes } from './mapMesh.ts';
import type { MapMaterials } from './materials.ts';
import { modelDataReady, readAccessor, readModel } from './modelData.testUtil.ts';

await modelDataReady;

/** Read the shipped surfaces, independently of the generated shared collision data. */
function shippedGeometry(id: string): THREE.BufferGeometry {
  const model = readModel(new URL(`../../public/models/${id}/${id}.gltf`, import.meta.url));
  const prim = model.json.meshes[0]!.primitives[0]!;
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(readAccessor(model, prim.attributes.POSITION!).data, 3),
  );
  g.setIndex(Array.from(readAccessor(model, prim.indices!).data));
  g.computeBoundingBox();
  return g;
}

beforeAll(initPhysics);

describe('shipped model surfaces match shared physics', () => {
  const geometries = new Map(PROP_MODEL_IDS.map((id) => [id, shippedGeometry(id)]));
  const sizes = measureSizes(geometries);
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  const fallbackMaterials = {
    get: () => material,
    variant: () => material,
  } as unknown as MapMaterials;
  it('validates every shipped mesh and rejects changed triangles even at the same bounds', () => {
    for (const [id, geometry] of geometries) validatePropGeometry(id, geometry);
    const stale = geometries.get('crate')!.clone();
    const index = stale.getIndex()!;
    index.setX(0, index.getX(1));
    expect(() => validatePropGeometry('crate', stale)).toThrow(/collision geometry mismatch/);
    stale.dispose();
  });
  const cases: MapDefinition[] = [
    ...[crate({ x: 0, z: 0, rot: 27 }), jersey({ x: 0, z: 0, rot: 37 }, 4)].map(
      (boxes): MapDefinition => ({
        name: 'cover',
        bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
        boxes,
        spawns: [],
        dummies: [],
      }),
    ),
    ...DECOR_KINDS.map((kind): MapDefinition => ({
      name: kind,
      bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
      boxes: [],
      decor: [{ kind, x: 0, z: 0, rot: 31 }],
      spawns: [],
      dummies: [],
    })),
  ];

  for (const map of cases) {
    it(`${map.name}: hits and gaps agree at the actual mesh, including tapered edges and holes`, () => {
      const physics = new PhysicsWorld(map);
      const fallback = buildMapMeshes(map, fallbackMaterials, { bakes: [] });
      fallback.updateMatrixWorld(true);
      const instances = [
        ...map.boxes.flatMap((b) => fitBox(b, sizes)),
        ...(map.decor ?? []).flatMap((d) => fitDecor(d, sizes)),
      ];
      const meshes = instances.map((i) => {
        const mesh = new THREE.Mesh(geometries.get(i.model), material);
        mesh.position.copy(i.pos);
        mesh.quaternion.copy(i.quat);
        mesh.scale.copy(i.scale);
        mesh.updateMatrixWorld(true);
        return mesh;
      });
      const bounds = new THREE.Box3();
      for (const m of meshes) bounds.expandByObject(m);
      const ray = new THREE.Raycaster();
      try {
        for (const axis of ['x', 'y', 'z'] as const) {
          const cross = (['x', 'y', 'z'] as const).filter((k) => k !== axis);
          for (let a = 0; a < 11; a++) {
            for (let b = 0; b < 11; b++) {
              const origin = bounds.min.clone();
              origin[axis] -= 1;
              origin[cross[0]!] +=
                (bounds.max[cross[0]!] - bounds.min[cross[0]!]) * ((a + 0.43) / 11);
              origin[cross[1]!] +=
                (bounds.max[cross[1]!] - bounds.min[cross[1]!]) * ((b + 0.37) / 11);
              const direction = new THREE.Vector3();
              direction[axis] = 1;
              ray.set(origin, direction);
              const visual = ray.intersectObjects(meshes, false)[0];
              const offline = ray.intersectObject(fallback, true)[0];
              const solid = physics.castRay(origin, direction, 20);
              expect(!!offline).toBe(!!visual);
              expect(!!solid).toBe(!!visual);
              if (offline && visual)
                expect(Math.abs(offline.distance - visual.distance)).toBeLessThan(0.003);
              if (solid && visual)
                expect(Math.abs(solid.distance - visual.distance)).toBeLessThan(0.003);
            }
          }
        }
      } finally {
        fallback.traverse((o) => {
          if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
        });
        physics.free();
      }
    });
  }
});
