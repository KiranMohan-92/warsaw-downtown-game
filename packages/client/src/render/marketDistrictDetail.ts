import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MapBox, MapDefinition, MaterialId } from '@wd/shared';
import type { MapMaterials } from './materials.ts';
import { patchLampVolume } from './lampLight.ts';
import { buildMarketContainerPieces } from './marketContainerDetail.ts';
import {
  addHallSky,
  HALL_SKY_ATTRIBUTE,
  hallDecalLift,
  type DecalLift,
} from './marketHallInterior.ts';
import { buildMarketInteriorPieces } from './marketInteriorDetail.ts';
import type { ResolvedQuality } from './post.ts';

interface DetailPiece {
  geo: THREE.BufferGeometry;
  mat: MaterialId;
  color: number;
  source?: MapBox;
}
const CHUNK = 32;
const tint = new THREE.Color();
const center = new THREE.Vector3();

// Fittings can overlap a player's silhouette: keep their reach identical on every tier.
const DISTANCES = [30, 42] as const;

/** Bullet-hole placement over the hall's dressing (`Effects.setDecalLift`); 0 without a hall. */
export function marketDetailDecalLift(root: THREE.Group): DecalLift {
  return root.userData.decalLift as DecalLift;
}

/** World-space chunks retain nearby fittings; hysteresis avoids toggling at the boundary. */
export function updateMarketDistrictDetail(
  root: THREE.Group,
  camera: Readonly<THREE.Vector3>,
  _quality: ResolvedQuality,
): void {
  const [show, hide] = DISTANCES;
  for (const object of root.children) {
    if (!(object instanceof THREE.Mesh)) continue;
    const box = (object as THREE.Mesh<THREE.BufferGeometry>).geometry.boundingBox;
    if (!box) continue;
    const dx = Math.max(box.min.x - camera.x, 0, camera.x - box.max.x);
    const dy = Math.max(box.min.y - camera.y, 0, camera.y - box.max.y);
    const dz = Math.max(box.min.z - camera.z, 0, camera.z - box.max.z);
    const reach = object.visible ? hide : show;
    object.visible = dx * dx + dy * dy + dz * dz <= reach * reach;
  }
}

/** Additions are presentation-only and reuse the authored solids, surfaces and room light volume. */
export function buildMarketDistrictDetail(
  map: MapDefinition,
  materials: MapMaterials,
): THREE.Group {
  const root = new THREE.Group();
  root.name = 'market-detail';
  const interiors = buildMarketInteriorPieces(map);
  // Before merging (the pieces' geometries are disposed): where bullet holes land on the skins.
  const lift = hallDecalLift(interiors.filter((p) => p.sourceIndex < 0));
  const sets: [string, DetailPiece[]][] = [
    ['containers', buildMarketContainerPieces(map)],
    ['interiors', interiors],
  ];
  let triangles = 0;
  for (const [area, pieces] of sets) {
    const buckets = new Map<string, { mat: MaterialId; geometries: THREE.BufferGeometry[] }>();
    for (const piece of pieces) {
      const geo = piece.geo;
      geo.computeBoundingBox();
      geo.boundingBox!.getCenter(center);
      const key = `${piece.mat}|${Math.floor(center.x / CHUNK)},${Math.floor(center.z / CHUNK)}`;
      const position = geo.getAttribute('position');
      // Hall dressing arrives with its own colours (tint × grime) and sky occlusion.
      if (!geo.getAttribute('color')) {
        const colours = new Float32Array(position.count * 3);
        tint.setHex(piece.color, THREE.SRGBColorSpace);
        const floor = piece.source
          ? piece.source.center.y - piece.source.size.y / 2
          : geo.boundingBox!.min.y;
        for (let i = 0; i < position.count; i++) {
          // Subtle splash dirt on fittings near their original solid's lower edge, at load time.
          const height = position.getY(i) - floor;
          const dirt = Math.max(0, 1 - Math.max(0, height) / 0.25) * 0.12;
          colours[i * 3] = tint.r * (1 - dirt);
          colours[i * 3 + 1] = tint.g * (1 - dirt);
          colours[i * 3 + 2] = tint.b * (1 - dirt);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
      }
      if (area === 'interiors' && !geo.getAttribute(HALL_SKY_ATTRIBUTE))
        geo.setAttribute(
          HALL_SKY_ATTRIBUTE,
          new THREE.BufferAttribute(new Float32Array(position.count).fill(1), 1),
        );
      if (!geo.getAttribute('uv'))
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
      // Existing wear material safely skips custom details without a source face coordinate.
      if (!geo.getAttribute('aFace'))
        geo.setAttribute(
          'aFace',
          new THREE.BufferAttribute(new Float32Array(position.count * 4), 4),
        );
      const bucket = buckets.get(key) ?? { mat: piece.mat, geometries: [] };
      bucket.geometries.push(geo);
      buckets.set(key, bucket);
      triangles += (geo.index?.count ?? position.count) / 3;
    }
    for (const [key, bucket] of buckets) {
      const geo = mergeGeometries(bucket.geometries, false);
      for (const part of bucket.geometries) part.dispose();
      if (!geo) throw new Error(`Market detail: incompatible geometry in ${key}`);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mat =
        area === 'interiors'
          ? materials.variant(bucket.mat, 'market-interior-detail', (m) => {
              // Sky occlusion first: its hook goes before aomap_fragment, the lamps' after it.
              addHallSky(m);
              patchLampVolume(m, 'world');
            })
          : materials.get(bucket.mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `market-detail:${area}|${key}`;
      // Thin rods, hinges and trim outside already carry authored dirt/room illumination. The
      // container's structural surfaces still receive the sun's shadow, and so does everything
      // indoors (the hall's metal cladding — counter tops, thresholds, the duct — must not catch
      // direct sun under a floor). receiveShadow is a uniform: no program variant.
      mesh.receiveShadow = bucket.mat !== 'metal' || area === 'interiors';
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      // Interior cladding covers the walls and floor it stands on: drawn first, it lets them fail
      // the depth test instead of shading every covered pixel twice (as the street slab does).
      if (area === 'interiors') mesh.renderOrder = -1;
      root.add(mesh);
    }
  }
  root.userData.decalLift = lift;
  root.userData.triangles = triangles;
  root.userData.batches = root.children.length;
  return root;
}
