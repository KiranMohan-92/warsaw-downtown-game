import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addWetness, WET_FRAGMENT } from './materials.ts';
import { DROP_COUNT, Rain, SPLASH_COUNT } from './rain.ts';
import { RAINING, rainOcclusion, rainStop, rainTime } from './rainOcclusion.ts';
import { DROP_MAX_MM, DROP_MIN_MM } from './rainPhysics.ts';

type Internals = {
  dropGeo: THREE.InstancedBufferGeometry;
  splashGeo: THREE.InstancedBufferGeometry;
  dropMat: THREE.ShaderMaterial;
  splashMat: THREE.ShaderMaterial;
  curtainMat: THREE.ShaderMaterial;
  windOff: THREE.Vector2;
};

describe('rain', () => {
  it('draws one fixed, seeded drop field whatever the quality (tier parity)', () => {
    const a = new Rain() as unknown as Internals;
    const b = new Rain() as unknown as Internals;
    const da = a.dropGeo.getAttribute('aDrop').array as Float32Array;
    const db = b.dropGeo.getAttribute('aDrop').array as Float32Array;
    expect(da.length).toBe(DROP_COUNT * 4);
    expect(Array.from(da.slice(0, 64))).toEqual(Array.from(db.slice(0, 64)));
    for (let i = 3; i < da.length; i += 4) {
      expect(da[i]).toBeGreaterThanOrEqual(DROP_MIN_MM);
      expect(da[i]).toBeLessThanOrEqual(DROP_MAX_MM);
    }
    // No quality input exists: the only knob is the weather's rain amount.
    expect(Rain.prototype).not.toHaveProperty('setQuality');
    expect(a.splashGeo.instanceCount).toBe(SPLASH_COUNT);
  });

  it('scales drops with the rain amount and hides when dry', () => {
    const r = new Rain();
    const i = r as unknown as Internals;
    r.setIntensity(1);
    expect(i.dropGeo.instanceCount).toBe(DROP_COUNT);
    expect(r.mesh.visible).toBe(true);
    r.setIntensity(0.5);
    expect(i.dropGeo.instanceCount).toBe(DROP_COUNT / 2);
    r.setIntensity(0);
    expect(r.mesh.visible).toBe(false);
  });

  it('stops drops, splashes and the curtain at the occlusion map (shared sampler)', () => {
    const i = new Rain() as unknown as Internals;
    for (const m of [i.dropMat, i.splashMat, i.curtainMat]) {
      expect(m.uniforms.uRainOcc).toBe(rainOcclusion.map);
      expect(m.uniforms.uRainOccRect).toBe(rainOcclusion.rect);
    }
    expect(i.dropMat.vertexShader).toContain('p.y < rainTopAt( p.xz ).x');
    // Splashes: hard exposed tops only (G = foliage).
    expect(i.splashMat.vertexShader).toContain('top.y > 0.5');
    // Same output path on every tier: tone mapping + colour space in the shader.
    for (const m of [i.dropMat, i.splashMat, i.curtainMat]) {
      expect(m.fragmentShader).toContain('#include <tonemapping_fragment>');
    }
  });

  it('drifts with the wind and integrates gusts without jumps', () => {
    const r = new Rain();
    const i = r as unknown as Internals;
    r.setIntensity(1);
    const cam = new THREE.PerspectiveCamera();
    const dir = new THREE.Vector2(1, 0);
    r.update(1 / 60, cam, 1, 0, dir);
    const x0 = i.windOff.x;
    r.update(1 / 60, cam, 1, 1, dir);
    const step = i.windOff.x - x0;
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(0.15); // ≤ 9 m/s × 1/60 s
  });
});

describe('wet materials', () => {
  it('dry under cover: the wetness reads the rain occlusion along the normal', () => {
    const mat = new THREE.MeshStandardMaterial();
    addWetness(mat);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.uRainOcc).toBe(rainOcclusion.map);
    expect(shader.vertexShader).toContain('vWetPos =');
    expect(shader.fragmentShader).toContain('rainExposure( vWetPos + wetN * 0.3 )');
    // Porosity: metal and smooth surfaces darken less than rough dielectrics.
    expect(WET_FRAGMENT).toContain('( 1.0 - metalnessFactor )');
    // The shelter lookup is Medium+ only (Low keeps its frame budget; looks only).
    expect(WET_FRAGMENT).toMatch(
      /#ifndef TONE_MAPPING\s+if \( distance\( vWetPos, cameraPosition \) < 70\.0 \)/,
    );
  });
});

describe('rain review fixes', () => {
  it('draws the streaks with the tested footprint and kernel (rainPhysics mirrors)', () => {
    const i = new Rain() as unknown as Internals;
    const vs = i.dropMat.vertexShader;
    const fs = i.dropMat.fragmentShader;
    // Coverage over the kernel's exact area; past the cap longer, then wider up to maxW (coverage
    // carried over, capped ∝ target²); scale-invariant width cap; cull by screen share.
    expect(vs).toContain('coverage / ( width * ( drawLen + width ) ) );');
    expect(vs).toContain('drawLen = min( maxLen, coverage / (');
    expect(vs).toContain('width = min( maxW, max( width, wFit ) );');
    expect(vs).toContain('float coverage = min( raw, ');
    expect(vs).toContain('float width = clamp( sqrt( sharp * sharp + blur * blur ), 1.0, maxW );');
    expect(vs).toContain('* uViewport.x * uViewport.y )');
    // Placement: the quad leads the drop by half a width only (streakLeadPx); the ramps trail.
    expect(vs).toContain('dir * ( along - width * 0.5 );');
    // The kernel: hard box for 1 px, 1 px-edged bar else; tapered trapezoid along.
    expect(fs).toContain(
      'float across = w <= 1.0 ? 1.0 : clamp( w * 0.5 + 0.5 - abs( vAcross.x ), 0.0, 1.0 );',
    );
    expect(fs).toContain(
      'clamp( vAlong.x / vAlong.z, 0.0, 1.0 ) * clamp( ( vAlong.y - vAlong.x ) / vAlong.z, 0.0, 1.0 )',
    );
  });

  it('keeps the curtain mist out of sheltered air (no haze in the metro)', () => {
    const i = new Rain() as unknown as Internals;
    expect(i.curtainMat.fragmentShader).toContain('* 0.07 * smoothstep( -0.1, 0.0, h )');
  });

  it('lets the puddle ripples play out after the rain stops, with no new impacts', () => {
    const r = new Rain();
    const cam = new THREE.PerspectiveCamera();
    r.setIntensity(1);
    r.update(0.5, cam);
    expect(rainStop.value).toBe(RAINING);
    r.setIntensity(0); // sunny: the rain mesh hides
    r.update(0.1, cam);
    const stopped = rainStop.value;
    expect(stopped).toBeLessThan(RAINING);
    const t0 = rainTime.value;
    r.update(0.4, cam);
    expect(rainTime.value).toBeCloseTo(t0 + 0.4, 6); // the clock keeps running
    expect(rainStop.value).toBe(stopped);
    r.setIntensity(1);
    r.update(0.1, cam);
    expect(rainStop.value).toBe(RAINING);
  });

  it('on Low drops only the splash crowns; drops and curtain (the concealment) stay', () => {
    const r = new Rain();
    const i = r as unknown as Internals & {
      splashes: THREE.Mesh;
      drops: THREE.Mesh;
      curtain: THREE.Mesh;
    };
    r.setIntensity(1);
    r.setLowQuality(true);
    expect(i.splashes.visible).toBe(false);
    expect(i.drops.visible).toBe(true);
    expect(i.curtain.visible).toBe(true);
    expect(i.dropGeo.instanceCount).toBe(DROP_COUNT);
    r.setLowQuality(false);
    expect(i.splashes.visible).toBe(true);
  });
});
