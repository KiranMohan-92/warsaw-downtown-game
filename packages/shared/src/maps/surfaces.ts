import type { PropModelId } from './propModels.ts';
import type { MaterialId } from './types.ts';

/** What a bullet (or a boot) hits, for impact sounds/effects. Presentation only: never gameplay. */
export type SurfaceKind = 'stone' | 'metal' | 'wood' | 'glass' | 'soft';

const MATERIAL_SURFACE: Record<MaterialId, SurfaceKind> = {
  ground: 'soft',
  asphalt: 'stone',
  sidewalk: 'stone',
  concrete: 'stone',
  plaster: 'stone',
  wood: 'wood',
  metal: 'metal',
  trim: 'stone',
  accent: 'metal',
  grass: 'soft',
  paving: 'stone',
  facade: 'stone',
  glass: 'glass',
  foliage: 'soft',
  bark: 'wood',
  paint: 'metal',
  container: 'metal',
  tile: 'stone',
  terrazzo: 'stone',
  wreck: 'metal',
  sandbag: 'soft',
};

const MODEL_SURFACE: Record<PropModelId, SurfaceKind> = {
  crate: 'wood',
  crate_small: 'wood',
  cardboard_box: 'wood',
  jersey: 'stone',
  drum: 'metal',
  bin: 'metal',
  lamp: 'metal',
  utility_box: 'metal',
  trashbag: 'soft',
  tyre: 'soft',
  // Fabric cover over the body: a dull puff, not sparks.
  car: 'soft',
};

export const surfaceOfMaterial = (mat: MaterialId): SurfaceKind => MATERIAL_SURFACE[mat];
export const surfaceOfModel = (model: PropModelId): SurfaceKind => MODEL_SURFACE[model];
