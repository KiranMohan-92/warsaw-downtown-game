import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { MapBox, MapDefinition } from '@wd/shared';
import {
  NeonDistrict,
  NEON_SIGNS,
  cssSrgbColor,
  makeWetNeonMetalMaterial,
  neonSignTextLayout,
  neonStripPlacements,
} from './neonDistrict.ts';

const box = (
  x: number,
  z: number,
  size: Partial<MapBox['size']> = {},
  mat: MapBox['mat'] = 'container',
): MapBox => ({
  center: { x, y: 1, z },
  size: { x: size.x ?? 4, y: size.y ?? 2, z: size.z ?? 1.4 },
  mat,
});

const mapOf = (boxes: MapBox[]): MapDefinition => ({
  name: 'test',
  bounds: { minX: 0, maxX: 200, minZ: -80, maxZ: 80 },
  boxes,
  spawns: [],
  dummies: [],
});

function compileMaterialSource(material: THREE.MeshStandardMaterial): {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, unknown>;
} {
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: '#include <common>\n#include <project_vertex>',
    fragmentShader: '#include <common>\n#include <normal_fragment_maps>',
  };
  material.onBeforeCompile(
    shader as Parameters<NonNullable<typeof material.onBeforeCompile>>[0],
    {
      type: 'WebGLRenderer',
    } as unknown as THREE.WebGLRenderer,
  );
  return shader;
}

describe('NeonDistrict', () => {
  it('replaces only baked ground cards and restores the fallback without adding draw calls', () => {
    const district = new NeonDistrict(mapOf([]));
    const cards = district.group.getObjectByName(
      'neon-wet-reflection-cards',
    ) as THREE.InstancedMesh;
    const original = Array.from({ length: NEON_SIGNS.length }, (_, i) => {
      const matrix = new THREE.Matrix4();
      cards.getMatrixAt(i, matrix);
      return matrix;
    });
    district.setBakedGroundSigns(['NOCNY RYNEK']);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < NEON_SIGNS.length; i++) {
      cards.getMatrixAt(i, matrix);
      if (NEON_SIGNS[i]!.label === 'NOCNY RYNEK') expect(matrix.determinant()).toBe(0);
      else expect(matrix.equals(original[i]!)).toBe(true);
    }
    district.setBakedGroundSigns([]);
    for (let i = 0; i < NEON_SIGNS.length; i++) {
      cards.getMatrixAt(i, matrix);
      expect(matrix.equals(original[i]!)).toBe(true);
    }
    expect(cards.count).toBe(4);
    district.dispose();
  });
  it('keeps signage bounded, readable and hidden until the neon preset enables it', () => {
    const map = mapOf([
      box(50, -40),
      box(80, 20, { x: 6 }, 'paint'),
      box(120, -20, { z: 6 }, 'metal'),
      box(210, 0),
    ]);
    const district = new NeonDistrict(map);
    expect(district.group.visible).toBe(false);
    district.setEnabled(true);
    expect(district.group.visible).toBe(true);
    expect(NEON_SIGNS).toHaveLength(4);
    for (const spec of NEON_SIGNS) {
      expect(spec.label.length).toBeGreaterThan(5);
      expect(spec.x).toBeGreaterThanOrEqual(38);
      expect(spec.x).toBeLessThanOrEqual(170);
      expect(spec.z).toBeGreaterThanOrEqual(-62);
      expect(spec.z).toBeLessThanOrEqual(64);
      expect(spec.y).toBeGreaterThan(3);
    }
  });

  it('uses corrected sRGB text colour and stable proportional texture layout', () => {
    expect(cssSrgbColor(0x5ee7ff)).toBe('rgb(94, 231, 255)');
    const layouts = NEON_SIGNS.map(neonSignTextLayout);
    expect(layouts.map((layout) => layout.textureWidth)).toEqual([1024, 1024, 1024, 1024]);
    expect(layouts.map((layout) => layout.textureHeight)).toEqual([282, 329, 394, 323]);
    expect(layouts[0]!.labelCenterY / layouts[0]!.textureHeight).toBeCloseTo(0.43);
    expect(layouts[0]!.sublabelCenterY / layouts[0]!.textureHeight).toBeCloseTo(0.66);
    expect(neonSignTextLayout(NEON_SIGNS[0]!)).toEqual(layouts[0]);
  });

  it('uses a small draw-call budget by batching strips, housings, supports, frame hardware and reflection cards', () => {
    const district = new NeonDistrict(
      mapOf([box(50, -40), box(80, 20, { x: 6 }, 'paint'), box(120, -20, { z: 6 }, 'metal')]),
    );
    let visibleDraws = 0;
    district.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) visibleDraws++;
    });
    expect(visibleDraws).toBeLessThanOrEqual(12);
    const hardware = district.group.getObjectByName(
      'neon-sign-frame-hardware',
    ) as THREE.InstancedMesh;
    expect(hardware.count).toBe(NEON_SIGNS.length * 10);
    expect((hardware.geometry.index!.count / 3) * hardware.count).toBe(480);
    expect((hardware.geometry.index!.count / 3) * hardware.count).toBeLessThanOrEqual(1200);
  });

  it('chains existing wetness shader treatment onto sign metal without extra draw cost', () => {
    const housing = makeWetNeonMetalMaterial(0x101722, 0.72, 0.65);
    const support = makeWetNeonMetalMaterial(0x11151c, 0.6, 0.8);
    for (const mat of [housing, support]) {
      expect(mat.customProgramCacheKey()).toBe('wet');
      const shader = compileMaterialSource(mat);
      expect(shader.uniforms.uWetness).toBeTruthy();
      expect(shader.uniforms.uRainOcc).toBeTruthy();
      expect(shader.vertexShader).toContain('vWetPos');
      expect(shader.fragmentShader).toContain('roughnessFactor = mix');
      expect(shader.fragmentShader).toContain('rainExposure');
    }
    housing.dispose();
    support.dispose();
  });

  it('keeps sign panels at exact physical dimensions while animating intensity only', () => {
    const district = new NeonDistrict(mapOf([]));
    const panels = NEON_SIGNS.map(
      (spec) =>
        district.group.getObjectByName(
          `hologram-${spec.label.toLowerCase().replaceAll(' ', '-')}`,
        ) as THREE.Mesh,
    );
    const scales = panels.map((panel) => panel.scale.clone());
    district.setEnabled(true);
    district.update(1.5);
    for (let i = 0; i < panels.length; i++) {
      expect(panels[i]!.scale.equals(scales[i]!)).toBe(true);
      expect(scales[i]!.x).toBe(NEON_SIGNS[i]!.w);
      expect(scales[i]!.y).toBe(NEON_SIGNS[i]!.h);
    }
    district.dispose();
  });

  it('selects mounted strips only from visible market hardware', () => {
    const placements = neonStripPlacements(
      mapOf([
        box(45, -40),
        { ...box(80, 20), visible: false },
        box(180, 0),
        box(120, 20, { x: 0.7 }),
        box(95, 10, { z: 5 }, 'glass'),
      ]),
    );
    expect(placements).toHaveLength(2);
    expect(placements.every((p) => p.y > 1.9)).toBe(true);
    expect(placements.every((p) => p.length >= 1.4)).toBe(true);
  });

  it('animates only while visible and releases GPU resources on dispose', () => {
    const district = new NeonDistrict(mapOf([box(50, -40)]));
    const disposed: string[] = [];
    district.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh)) return;
      if (o instanceof THREE.InstancedMesh)
        vi.spyOn(o, 'dispose').mockImplementation(() => disposed.push('instance'));
      const material = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of material) vi.spyOn(m, 'dispose').mockImplementation(() => disposed.push('m'));
      vi.spyOn(o.geometry, 'dispose').mockImplementation(() => disposed.push('g'));
      for (const m of material) {
        const map = (m as THREE.MeshBasicMaterial).map;
        if (map) vi.spyOn(map, 'dispose').mockImplementation(() => disposed.push('t'));
      }
    });
    district.update(1);
    district.setEnabled(true);
    district.update(1);
    district.dispose();
    expect(disposed).toContain('g');
    expect(disposed).toContain('m');
    expect(disposed).toContain('t');
    expect(disposed.filter((kind) => kind === 'instance')).toHaveLength(6);
    expect(district.group.children).toHaveLength(0);
  });
});
