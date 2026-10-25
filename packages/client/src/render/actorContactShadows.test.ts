import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { ActorContactShadows, type ActorGroundProbe } from './actorContactShadows.ts';

function cameraAt(x = 0, y = 1.6, z = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  camera.updateMatrixWorld(true);
  return camera;
}

function flatProbe(
  y = 0,
  normal = new THREE.Vector3(0, 1, 0),
  origins?: THREE.Vector3[],
): ActorGroundProbe {
  return (origin, outPoint, outNormal) => {
    origins?.push(origin.clone());
    outPoint.set(origin.x, y, origin.z);
    outNormal.copy(normal);
    return origin.y - y;
  };
}

function unsupportedProbe(): ActorGroundProbe {
  return () => null;
}

function renderOne(
  layer: ActorContactShadows,
  pos: THREE.Vector3,
  camera = cameraAt(),
  grounded = true,
): number {
  layer.begin(camera, true);
  layer.add(pos, grounded);
  layer.end();
  return layer.visibleCount;
}

function alphaAt(layer: ActorContactShadows, index: number): number {
  const attr = layer.mesh.geometry.getAttribute('instanceAlpha') as THREE.InstancedBufferAttribute;
  return attr.getX(index);
}

function matrixPosition(layer: ActorContactShadows, index: number): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  layer.mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}

describe('ActorContactShadows', () => {
  it('constructs one instanced transparent shadow draw with a procedural alpha texture', () => {
    const layer = new ActorContactShadows(flatProbe());
    const material = layer.mesh.material as THREE.MeshBasicMaterial;
    const alpha = layer.mesh.geometry.getAttribute(
      'instanceAlpha',
    ) as THREE.InstancedBufferAttribute;
    const texture = material.map as THREE.DataTexture;
    const data = texture.image.data as Uint8Array;
    const center = (16 * 32 + 16) * 4 + 3;
    const corner = 3;

    expect(layer.mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect(layer.mesh.count).toBe(0);
    expect(layer.mesh.children).toHaveLength(0);
    expect(layer.mesh.castShadow).toBe(false);
    expect(layer.mesh.receiveShadow).toBe(false);
    expect(layer.mesh.frustumCulled).toBe(false);
    expect(alpha.count).toBe(64);
    expect(alpha.usage).toBe(THREE.DynamicDrawUsage);
    expect(layer.mesh.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
    expect(material.transparent).toBe(true);
    expect(material.depthTest).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.image.width).toBe(32);
    expect(texture.image.height).toBe(32);
    expect(data[corner]).toBe(0);
    expect(data[center]).toBeGreaterThan(200);
  });

  it('hides airborne, unsupported, steep-normal, and excessive-gap actors', () => {
    const camera = cameraAt();
    expect(
      renderOne(new ActorContactShadows(flatProbe()), new THREE.Vector3(50, 0, 0), camera, false),
    ).toBe(0);
    expect(
      renderOne(new ActorContactShadows(unsupportedProbe()), new THREE.Vector3(50, 0, 0), camera),
    ).toBe(0);
    expect(
      renderOne(
        new ActorContactShadows(flatProbe(0, new THREE.Vector3(0.8, 0.6, 0))),
        new THREE.Vector3(50, 0, 0),
        camera,
      ),
    ).toBe(0);
    expect(
      renderOne(new ActorContactShadows(flatProbe()), new THREE.Vector3(50, 0.251, 0), camera),
    ).toBe(0);
    expect(
      renderOne(new ActorContactShadows(flatProbe()), new THREE.Vector3(50, 0.25, 0), camera),
    ).toBe(1);
  });

  it('places shadows on high support surfaces without lowering actors to street level', () => {
    const layer = new ActorContactShadows(flatProbe(6));
    expect(renderOne(layer, new THREE.Vector3(55, 6.1, 0))).toBe(1);
    const placed = matrixPosition(layer, 0);
    expect(placed.y).toBeGreaterThan(6);
    expect(placed.y).toBeLessThan(6.03);

    const streetProbe = new ActorContactShadows(flatProbe(0));
    expect(renderOne(streetProbe, new THREE.Vector3(55, 6.1, 0))).toBe(0);
  });

  it('fades in after near directional-shadow range and culls at far range', () => {
    const layer = new ActorContactShadows(flatProbe());
    const camera = cameraAt(0, 0, 0);

    layer.begin(camera, true);
    layer.add(new THREE.Vector3(20, 0, 0));
    layer.add(new THREE.Vector3(40, 0, 0));
    layer.add(new THREE.Vector3(60, 0, 0));
    layer.add(new THREE.Vector3(181, 0, 0));
    layer.end();

    expect(layer.visibleCount).toBe(2);
    expect(alphaAt(layer, 0)).toBeGreaterThan(0);
    expect(alphaAt(layer, 0)).toBeLessThan(alphaAt(layer, 1));
    expect(alphaAt(layer, 1)).toBeCloseTo(1, 5);
  });

  it('caps visible instances at 64 even when constructed with a larger capacity', () => {
    const origins: THREE.Vector3[] = [];
    const layer = new ActorContactShadows(flatProbe(0, new THREE.Vector3(0, 1, 0), origins), {
      capacity: 128,
    });
    const camera = cameraAt(0, 0, 0);

    layer.begin(camera, true);
    for (let i = 0; i < 80; i++) layer.add(new THREE.Vector3(55 + i, 0, 0));
    layer.end();

    const alpha = layer.mesh.geometry.getAttribute(
      'instanceAlpha',
    ) as THREE.InstancedBufferAttribute;
    expect(layer.visibleCount).toBe(64);
    expect(layer.mesh.count).toBe(64);
    expect(layer.mesh.instanceMatrix.count).toBe(64);
    expect(alpha.count).toBe(64);
    expect(origins).toHaveLength(64);
  });

  it('reuses the same buffers and texture across frames', () => {
    const layer = new ActorContactShadows(flatProbe());
    const alpha = layer.mesh.geometry.getAttribute('instanceAlpha');
    const matrix = layer.mesh.instanceMatrix;
    const texture = (layer.mesh.material as THREE.MeshBasicMaterial).map;
    const camera = cameraAt();

    layer.begin(camera, true);
    layer.add(new THREE.Vector3(50, 0, 0));
    layer.end();
    expect(layer.visibleCount).toBe(1);

    layer.begin(camera, true);
    layer.add(new THREE.Vector3(55, 0, 0));
    layer.add(new THREE.Vector3(60, 0, 0));
    layer.end();

    expect(layer.visibleCount).toBe(2);
    expect(layer.mesh.geometry.getAttribute('instanceAlpha')).toBe(alpha);
    expect(layer.mesh.instanceMatrix).toBe(matrix);
    expect((layer.mesh.material as THREE.MeshBasicMaterial).map).toBe(texture);
  });

  it('keeps procedural textures private to each layer for safe disposal', () => {
    const first = new ActorContactShadows(flatProbe());
    const second = new ActorContactShadows(flatProbe());
    const firstTexture = (first.mesh.material as THREE.MeshBasicMaterial).map!;
    const secondTexture = (second.mesh.material as THREE.MeshBasicMaterial).map!;
    const disposeFirstTexture = vi.spyOn(firstTexture, 'dispose');
    const disposeSecondTexture = vi.spyOn(secondTexture, 'dispose');

    first.dispose();

    expect(firstTexture).not.toBe(secondTexture);
    expect(disposeFirstTexture).toHaveBeenCalledTimes(1);
    expect(disposeSecondTexture).not.toHaveBeenCalled();
  });

  it('skips rendering when disabled for the quality setting', () => {
    const origins: THREE.Vector3[] = [];
    const layer = new ActorContactShadows(flatProbe(0, new THREE.Vector3(0, 1, 0), origins));

    layer.begin(cameraAt(), false);
    layer.add(new THREE.Vector3(50, 0, 0));
    layer.end();

    expect(layer.visibleCount).toBe(0);
    expect(layer.mesh.count).toBe(0);
    expect(origins).toHaveLength(0);
  });

  it('disposes geometry, material, and procedural texture', () => {
    const layer = new ActorContactShadows(flatProbe());
    const material = layer.mesh.material as THREE.MeshBasicMaterial;
    const texture = material.map!;
    const disposeGeometry = vi.spyOn(layer.mesh.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    const disposeTexture = vi.spyOn(texture, 'dispose');

    layer.dispose();

    expect(disposeGeometry).toHaveBeenCalledTimes(1);
    expect(disposeMaterial).toHaveBeenCalledTimes(1);
    expect(disposeTexture).toHaveBeenCalledTimes(1);
  });
});
