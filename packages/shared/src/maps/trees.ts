/**
 * Tree metrics shared by physics and rendering. Every map tree is drawn as one of the baked
 * species (client render/treeModels.ts; EZ-Tree via tools/assets/bake_trees.mjs), chosen from its
 * position so every client and the server agree. The trunk collider is the drawn trunk: bullets
 * stop where you see bark.
 */
import type { MapTree } from './types.ts';

export type TreeSpecies = 'ash' | 'oak' | 'pine';
export const TREE_SPECIES: readonly TreeSpecies[] = ['ash', 'oak', 'pine'];

/**
 * Per species, in the baked model's unit space (height 1): the crown's horizontal reach and the
 * trunk radius at its base (public/models/trees/trees.json + the model; a client test checks
 * these against the shipped files).
 */
export const TREE_MODEL: Readonly<Record<TreeSpecies, { crown: number; trunk: number }>> = {
  ash: { crown: 0.4999, trunk: 0.0259 },
  oak: { crown: 0.4947, trunk: 0.0215 },
  pine: { crown: 0.3501, trunk: 0.0203 },
};

const hash = (x: number, z: number, salt: number): number => {
  const h = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return h - Math.floor(h);
};

/** The species of a map tree (deterministic from its position). */
export function treeSpecies(t: Pick<MapTree, 'x' | 'z' | 'kind'>): TreeSpecies {
  if (t.kind === 'conifer') return 'pine';
  return hash(t.x, t.z, 11) < 0.55 ? 'ash' : 'oak';
}

/**
 * Crown width as a fraction of height: the map's crowns (≈0.49 × height, drawn for the old
 * lollipop trees) scaled up to real plaza-tree proportions, within the species' natural shape.
 */
export function treeWidthRatio(t: Pick<MapTree, 'crown' | 'height'>, crownUnit: number): number {
  const fromMap = ((2 * t.crown) / t.height) * 1.35;
  return Math.min(2 * crownUnit, Math.max(0.55, Math.min(0.9, fromMap)));
}

/** Horizontal scale of a tree's model (its vertical scale is the tree's height). */
export function treeHorizontalScale(
  t: Pick<MapTree, 'x' | 'z' | 'kind' | 'crown' | 'height'>,
): number {
  const crown = TREE_MODEL[treeSpecies(t)].crown;
  return (treeWidthRatio(t, crown) * t.height) / (2 * crown);
}

/** Trunk radius at the base, as drawn (capped: keep-clear zones assume ≤ 0.45 m). */
export function treeTrunkRadiusOf(
  t: Pick<MapTree, 'x' | 'z' | 'kind' | 'crown' | 'height'>,
): number {
  return Math.min(0.45, TREE_MODEL[treeSpecies(t)].trunk * treeHorizontalScale(t));
}
