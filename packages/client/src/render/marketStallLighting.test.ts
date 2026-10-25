import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  addStallLight,
  rotateStallLight,
  sampleStallLight,
  setStallLightAttribute,
  STALL_LIGHT_ATTRIBUTE,
  STALL_LIGHT_KEY,
} from './marketStallLighting.ts';

function compiled(m: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.physical.uniforms),
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  m.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('market stall strip lighting', () => {
  it('samples warm direct light below the strip and keeps symmetry across the stall', () => {
    const left = sampleStallLight(new THREE.Vector3(-0.6, -1.28, 0.6));
    const right = sampleStallLight(new THREE.Vector3(0.6, -1.28, 0.6));
    expect(left.x).toBeGreaterThan(0.5);
    expect(left.x).toBeCloseTo(right.x, 3);
    expect(left.y).toBeCloseTo(-right.y, 3);
    expect(left.z).toBeGreaterThan(0);
    for (const v of left.toArray()) expect(Number.isFinite(v)).toBe(true);
  });

  it('does not light receivers above the strip or outside the stall footprint', () => {
    expect(sampleStallLight(new THREE.Vector3(0, -0.1, 0.95)).length()).toBe(0);
    expect(sampleStallLight(new THREE.Vector3(2.1, -1.28, 0.6)).length()).toBe(0);
    expect(sampleStallLight(new THREE.Vector3(0, -1.28, -1.2)).length()).toBe(0);
  });

  it('lets the tabletop receive light but blocks rays through the solid cover', () => {
    const top = sampleStallLight(new THREE.Vector3(0, -1.325, 0.6));
    const insideCounter = sampleStallLight(new THREE.Vector3(0, -1.8, 0.6));
    const back = sampleStallLight(new THREE.Vector3(0, -1.1, -0.94));
    expect(top.x).toBeGreaterThan(insideCounter.x + 1);
    expect(insideCounter.x).toBe(0);
    expect(back.x).toBe(0);
  });

  it('writes one vec4 light attribute per vertex, rotated by the stall frame', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, -1.325, 0.6, 2.0, -1.325, 0.6], 3),
    );
    const frame = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    setStallLightAttribute(geo, frame);
    const attr = geo.getAttribute(STALL_LIGHT_ATTRIBUTE);
    expect(attr.itemSize).toBe(4);
    expect(attr.getX(0)).toBeGreaterThan(0);
    expect(Math.abs(attr.getZ(0))).toBeGreaterThan(Math.abs(attr.getY(0)));
    expect(attr.getX(1)).toBe(0);
  });

  it('rotates the irradiance vector without normalizing away falloff', () => {
    const near = sampleStallLight(new THREE.Vector3(0, -1.325, 0.8));
    const far = sampleStallLight(new THREE.Vector3(0, -2.0, 0.8));
    const frame = new THREE.Matrix4().makeRotationY(Math.PI / 2);
    const rotated = rotateStallLight(near, frame);
    const len = (v: THREE.Vector4): number => Math.hypot(v.y, v.z, v.w);
    expect(len(rotated)).toBeCloseTo(len(near), 6);
    expect(len(near)).toBeGreaterThan(len(far));
  });

  it('patches standard materials once, after aoMap, with a safe zero default attribute', () => {
    const mat = new THREE.MeshStandardMaterial();
    const base = mat.customProgramCacheKey();
    expect(addStallLight(mat)).toBe(true);
    expect(addStallLight(mat)).toBe(false);
    const shader = compiled(mat);
    expect(
      shader.vertexShader.match(new RegExp(`attribute vec4 ${STALL_LIGHT_ATTRIBUTE}`, 'g')),
    ).toHaveLength(1);
    expect(shader.fragmentShader.indexOf('BRDF_Lambert(material.diffuseColor)')).toBeGreaterThan(
      shader.fragmentShader.indexOf('#include <aomap_fragment>'),
    );
    expect(shader.fragmentShader).not.toContain('texture(');
    expect(
      (mat as unknown as { defaultAttributeValues: Record<string, number[]> })
        .defaultAttributeValues[STALL_LIGHT_ATTRIBUTE],
    ).toEqual([0, 0, 0, 0]);
    expect(mat.customProgramCacheKey()).toBe(`${base}|${STALL_LIGHT_KEY}`);
  });
});
