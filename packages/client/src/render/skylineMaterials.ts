import * as THREE from 'three';
import { addWetness, type MapMaterials } from './materials.ts';
import { patchBudgetShadows } from './renderBudget.ts';
import { addSkylineWindows } from './skylineWindows.ts';

const backdrops = new WeakMap<MapMaterials, THREE.MeshStandardMaterial>();

/** Built before warm-up. No textures, per-building clones or tier-dependent defines. */
export function skylineBackdropMaterial(materials: MapMaterials): THREE.MeshStandardMaterial {
  const existing = backdrops.get(materials);
  if (existing) return existing;
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  addWetness(material);
  addSkylineWindows(material);
  patchBudgetShadows(material);
  backdrops.set(materials, material);
  return material;
}

/** Satin pane roughness (the base glass panes: ~0.12 procedural, ~0.04 scanned: sharp). */
export const SATIN_GLASS_ROUGHNESS = 0.38;

/** Uniform-only satin glass. Identical hooks, maps, defines and program key to the base glass. */
export function skylineSatinMaterial(materials: MapMaterials): THREE.MeshStandardMaterial {
  const base = materials.get('glass');
  // Both must be patched before sharing the key: otherwise the tier setup can append its
  // budget suffix to the clone after the base already appended it, reserving a second program.
  patchBudgetShadows(base);
  return materials.variant('glass', 'skyline-satin', (material) => {
    // three multiplies this by the inherited roughness map, so scale the map's typical (pane)
    // value up to the satin one; frames and slab bands saturate at 1 (matte). The scanned map
    // replaces the procedural one at load with much glossier panes: re-tune then.
    const tune = (): void => {
      material.roughness = SATIN_GLASS_ROUGHNESS / materials.typicalRoughness('glass');
    };
    tune();
    materials.onActiveMaps(tune);
    material.metalness = 0.12;
    // No envMapIntensity here: at Medium+ the glass takes its reflections from scene.environment,
    // whose intensity (scene.environmentIntensity) overrides a per-material value. The satin read
    // comes from roughness/metalness against the shared environment.
    patchBudgetShadows(material);
    // variant() normally reserves a different program key. Uniform changes need no new program.
    material.customProgramCacheKey = () => base.customProgramCacheKey();
  });
}
