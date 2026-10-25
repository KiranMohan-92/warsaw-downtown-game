/**
 * Facade detail: turns `facadeRelief.ts` quads into three merged material meshes (one draw call
 * each on every WebGL2 device) and picks a level of detail per spatial cell every frame.
 *
 * | LOD | what draws                                                      | where                  |
 * | --- | --------------------------------------------------------------- | ---------------------- |
 * | 0   | frame + detail (reveals, sills, hoods, courses) + glass panes    | near (per tier)        |
 * | 1   | frame + flat panels with the painted windows (facade texture)   | mid                    |
 * | 2   | same structural frame and painted panels as LOD 1              | far                    |
 *
 * All three draw the same windows in the same places (the relief snaps to the painted grid, and
 * distant tiers keep the same structural profile), so switching removes window detail, not walls.
 * Cells are 48 × 48 × 32 m. All LOD vertex buffers are allocated before warmUp; only the index
 * selection changes at transitions.
 * Merging keeps draw calls bounded without WEBGL_multi_draw and avoids per-instance matrix
 * textures in the vertex shader. Far cells retain the coarse shell without pane/reveal geometry.
 *
 * Materials are `MapMaterials` variants: the frame and detail use a clean sandstone shell (no
 * painted windows and no scanned plaster mottling), panes use glass (reflects the environment);
 * LOD 1/2 panels use the painted facade surface itself.
 * Concealment and collision are untouched: this is presentation only, identical in extent at
 * every tier (the relief never stands out of the collision plane).
 */
import * as THREE from 'three';
import { PALACE_TINT, type MapDefinition, type MaterialId, type Vec3 } from '@wd/shared';
import { type MapMaterials } from './materials.ts';
import { triangulateFacadeBoundary } from './facadeTriangulation.ts';
import { addWindowInteriors } from './windowInterior.ts';
import { addFacadeWeathering } from './facadeWeathering.ts';
import { addPalaceEntranceStone } from './palaceEntranceStone.ts';
import { palaceOrnamentVisibility, palaceReliefVisibility } from './palaceCavity.ts';
import {
  isPalaceSpire,
  palaceCrowns,
  palaceCrownGeometry,
  palaceClockGeometry,
  palaceSpireGeometry,
  type PalaceStoneGeometry,
} from './palaceSilhouette.ts';
import type { ResolvedQuality } from './post.ts';
import {
  facadeFaces,
  faceRelief,
  RELIEF_MIN,
  type FacadeFace,
  type FacadePart,
  type LocalQuad,
} from './facadeRelief.ts';

/** Level-of-detail distances per tier (m, from the camera to a cell's bounds). */
export const FACADE_LOD: Record<ResolvedQuality, { near: number; mid: number }> = {
  // Keep real window depth across a street, even on Low, within three merged draws.
  low: { near: 48, mid: 96 },
  medium: { near: 68, mid: 150 },
  high: { near: 96, mid: 240 },
  ultra: { near: 128, mid: 320 },
};
/** A cell must move this much past a threshold to switch back (no flicker at the boundary). */
export const FACADE_LOD_HYSTERESIS = 8;
/** Cell size (m): horizontal, vertical. */
export const FACADE_CELL = 48;
export const FACADE_CELL_Y = 32;

/** Window pane colour (linear; glass is metallic, so this mostly tints the reflection). */
const PANE = new THREE.Color(0.5, 0.55, 0.6);

/** World-space lightmap uv of a point on a face (baked maps only). */
export type LmUv = (p: Vec3) => readonly [number, number];

export interface FacadeBake {
  /** uv1 of points on wall `edge` of prism `prism`. */
  uvFor: (prism: number, edge: number) => LmUv;
  /** Reserved white atlas texel for client-only ornaments (no layout allocation / re-bake). */
  unbakedUv?: LmUv;
  /** The atlas lightmap and the variant key mapMesh uses for it. */
  tex: THREE.Texture;
  key: string;
  intensity: number;
}

/** Ornaments share the already-warmed stone program and the existing merged shell buffers. */
function emitStoneGeometry(b: PartBuilder, g: PalaceStoneGeometry, lm: LmUv | null): void {
  const base = b.vertexCount;
  for (let i = 0; i < g.pos.length; i += 3) {
    const p = { x: g.pos[i]!, y: g.pos[i + 1]!, z: g.pos[i + 2]! };
    b.pos.push(p.x, p.y, p.z);
    b.nrm.push(toSnorm(g.nrm[i]!), toSnorm(g.nrm[i + 1]!), toSnorm(g.nrm[i + 2]!));
    b.col.push(g.col[i]!, g.col[i + 1]!, g.col[i + 2]!);
    b.palace.push(255);
    b.panel.push(0);
    b.cavity.push(palaceOrnamentVisibility(g.nrm[i + 1]!));
    if (b.uv1) {
      const uv = lm ? lm(p) : [0, 0];
      b.uv1.push(toUnorm16(uv[0]), toUnorm16(uv[1]));
    }
  }
  for (const v of g.uv) b.uv.push(v);
  for (const i of g.idx) b.idx.push(base + i);
}

type MeshKind = 'shell' | 'glass' | 'paint';
const PART_MESH: Record<FacadePart, MeshKind> = {
  frame: 'shell',
  detail: 'shell',
  glass: 'glass',
  panel: 'paint',
};
const MESH_SURFACE: Record<MeshKind, MaterialId> = {
  shell: 'facade',
  glass: 'glass',
  paint: 'facade',
};
const PARTS: readonly FacadePart[] = ['frame', 'detail', 'glass', 'panel'];

/**
 * Geometry for one cell part. Byte normals save space; float colours keep per-building facade
 * tints out of material variants and shader defines.
 */
class PartBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly cavity: number[] = [];
  readonly palace: number[] = [];
  /** Analytic window/course masks belong only to window panels, never piers or ornaments. */
  readonly panel: number[] = [];
  readonly uv1: number[] | null;
  readonly idx: number[] = [];
  constructor(baked: boolean) {
    this.uv1 = baked ? [] : null;
  }
  get vertexCount(): number {
    return this.pos.length / 3;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.nrm), 3, true));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPalaceStone', new THREE.Uint8BufferAttribute(this.palace, 1, true));
    g.setAttribute('aFacadePanel', new THREE.Uint8BufferAttribute(this.panel, 1, true));
    g.setAttribute(
      'aFacadeOcclusion',
      new THREE.BufferAttribute(
        new Uint8Array(this.cavity.map((v) => Math.round(v * 255))),
        1,
        true,
      ),
    );
    if (this.uv1) {
      g.setAttribute('uv1', new THREE.BufferAttribute(new Uint16Array(this.uv1), 2, true));
    }
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** One spatial cell: ranges in the immutable source indices, bounds and current LOD. */
interface Cell {
  key: string;
  box: THREE.Box3;
  lod: 0 | 1 | 2;
  visible: boolean;
  ranges: Partial<Record<FacadePart, { start: number; count: number }>>;
  builders: Partial<Record<FacadePart, PartBuilder>>;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const toSnorm = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 127);
const toUnorm16 = (v: number): number => Math.round(clamp01(v) * 65535);
const EDGE_EPS = 1e-6;
const coordKey = (v: number): string => String(Math.round(v * 1_000_000));

/** Sky visibility inside the authored recess, independent of screen-space AO and sun shadows. */
function cavityVisibility(q: LocalQuad, depth: number, palace: boolean): number {
  const inset = clamp01(depth / RELIEF_MIN);
  if (palace) return palaceReliefVisibility(q.axis, q.sign, inset);
  if (q.axis === 'o') return 1 - inset * 0.18;
  // Under hoods sky access is lowest; open sills retain more sky. Interpolate across depth
  // so the reveal meets the exterior without a dark outline on its exposed lip.
  const shelter = q.axis === 'y' ? (q.sign < 0 ? 0.62 : 0.2) : 0.44;
  return 1 - shelter * inset;
}

interface PlaneBreaks {
  xsByY: Map<string, number[]>;
  ysByX: Map<string, number[]>;
}
type FrontBreaks = Map<string, PlaneBreaks>;

function addBreak(map: Map<string, number[]>, key: string, value: number): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function uniqueSorted(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    if (!out.length || Math.abs(v - out[out.length - 1]!) > EDGE_EPS) out.push(v);
  }
  return out;
}

function collectFrontBreaks(
  segs: readonly { parts: Record<FacadePart, LocalQuad[]> }[],
): FrontBreaks {
  const out: FrontBreaks = new Map();
  for (const seg of segs) {
    for (const part of PARTS) {
      for (const q of seg.parts[part]) {
        if (q.axis !== 'o') continue;
        const key = coordKey(q.o0);
        let plane = out.get(key);
        if (!plane) {
          plane = { xsByY: new Map(), ysByX: new Map() };
          out.set(key, plane);
        }
        addBreak(plane.xsByY, coordKey(q.y0), q.x0);
        addBreak(plane.xsByY, coordKey(q.y0), q.x1);
        addBreak(plane.xsByY, coordKey(q.y1), q.x0);
        addBreak(plane.xsByY, coordKey(q.y1), q.x1);
        addBreak(plane.ysByX, coordKey(q.x0), q.y0);
        addBreak(plane.ysByX, coordKey(q.x0), q.y1);
        addBreak(plane.ysByX, coordKey(q.x1), q.y0);
        addBreak(plane.ysByX, coordKey(q.x1), q.y1);
      }
    }
  }
  for (const plane of out.values()) {
    for (const [k, v] of plane.xsByY) plane.xsByY.set(k, uniqueSorted(v));
    for (const [k, v] of plane.ysByX) plane.ysByX.set(k, uniqueSorted(v));
  }
  return out;
}

function edgeValues(
  map: Map<string, number[]> | undefined,
  key: number,
  lo: number,
  hi: number,
): number[] {
  const values = map?.get(coordKey(key)) ?? [];
  return uniqueSorted([lo, ...values.filter((v) => v > lo + EDGE_EPS && v < hi - EDGE_EPS), hi]);
}

/** Emit one local quad of face `f` into builder `b` (world positions, normal, uvs, colour). */
function emitQuad(
  b: PartBuilder,
  f: FacadeFace,
  q: LocalQuad,
  colour: THREE.Color,
  lm: LmUv | null,
  breaks: FrontBreaks | null = null,
  panel = false,
): void {
  const uvY = (y: number): number =>
    q.uvY0 === undefined
      ? y
      : q.y1 === q.y0
        ? q.uvY0
        : q.uvY0 + ((y - q.y0) / (q.y1 - q.y0)) * (q.uvY1! - q.uvY0);
  // Face frame: along = (dx, 0, dz), up = +y, out = (dz, 0, -dx) (CCW footprint → outward).
  const ox = f.dz;
  const oz = -f.dx;
  let corners: [number, number, number][];
  let n: [number, number, number];
  if (q.axis === 'o') {
    corners = [
      [q.x0, q.y0, q.o0],
      [q.x1, q.y0, q.o0],
      [q.x1, q.y1, q.o0],
      [q.x0, q.y1, q.o0],
    ];
    n = [ox, 0, oz];
  } else if (q.axis === 's') {
    corners = [
      [q.x0, q.y0, q.o0],
      [q.x0, q.y0, q.o1],
      [q.x0, q.y1, q.o1],
      [q.x0, q.y1, q.o0],
    ];
    n = [f.dx * q.sign, 0, f.dz * q.sign];
  } else {
    corners = [
      [q.x0, q.y0, q.o0],
      [q.x1, q.y0, q.o0],
      [q.x1, q.y0, q.o1],
      [q.x0, q.y0, q.o1],
    ];
    n = [0, q.sign, 0];
  }
  const base = b.vertexCount;
  const plane = q.axis === 'o' ? breaks?.get(coordKey(q.o0)) : undefined;
  const bottomXs = plane ? edgeValues(plane.xsByY, q.y0, q.x0, q.x1) : [];
  const topXs = plane ? edgeValues(plane.xsByY, q.y1, q.x0, q.x1) : [];
  const leftYs = plane ? edgeValues(plane.ysByX, q.x0, q.y0, q.y1) : [];
  const rightYs = plane ? edgeValues(plane.ysByX, q.x1, q.y0, q.y1) : [];
  if (
    q.axis === 'o' &&
    (bottomXs.length > 2 || topXs.length > 2 || leftYs.length > 2 || rightYs.length > 2)
  ) {
    const points: [number, number, number][] = [];
    const addPoint = (p: [number, number, number]): void => {
      const last = points[points.length - 1];
      if (
        last &&
        Math.abs(last[0] - p[0]) <= EDGE_EPS &&
        Math.abs(last[1] - p[1]) <= EDGE_EPS &&
        Math.abs(last[2] - p[2]) <= EDGE_EPS
      ) {
        return;
      }
      points.push(p);
    };
    for (const x of bottomXs) addPoint([x, q.y0, q.o0]);
    for (const y of rightYs.slice(1)) addPoint([q.x1, y, q.o0]);
    for (const x of topXs.slice(0, -1).reverse()) addPoint([x, q.y1, q.o0]);
    for (const y of leftYs.slice(1, -1).reverse()) addPoint([q.x0, y, q.o0]);
    if (points.length > 1) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      if (
        Math.abs(first[0] - last[0]) <= EDGE_EPS &&
        Math.abs(first[1] - last[1]) <= EDGE_EPS &&
        Math.abs(first[2] - last[2]) <= EDGE_EPS
      ) {
        points.pop();
      }
    }
    const triangles = triangulateFacadeBoundary(points);
    const world: Vec3[] = points.map(([s, y, o]) => ({
      x: f.ax + f.dx * s + ox * o,
      y,
      z: f.az + f.dz * s + oz * o,
    }));
    for (let i = 0; i < points.length; i++) {
      const [s, y] = points[i]!;
      const p = world[i]!;
      b.pos.push(p.x, p.y, p.z);
      b.nrm.push(toSnorm(n[0]), toSnorm(n[1]), toSnorm(n[2]));
      b.uv.push(f.sa + s, uvY(y));
      b.col.push(colour.r, colour.g, colour.b);
      b.palace.push(f.style === 'monumental' ? 255 : 0);
      b.panel.push(panel && q.axis === 'o' ? 255 : 0);
      b.cavity.push(cavityVisibility(q, q.o0, f.style === 'monumental'));
      if (b.uv1) {
        const [a, c] = lm ? lm(p) : [0, 0];
        b.uv1.push(toUnorm16(a), toUnorm16(c));
      }
    }
    // Local CCW points face inward in the facade's along/up/out frame.
    for (let i = 0; i < triangles.length; i += 3) {
      b.idx.push(base + triangles[i]!, base + triangles[i + 2]!, base + triangles[i + 1]!);
    }
    return;
  }
  const world: Vec3[] = corners.map(([s, y, o]) => ({
    x: f.ax + f.dx * s + ox * o,
    y,
    z: f.az + f.dz * s + oz * o,
  }));
  for (let i = 0; i < 4; i++) {
    const [s, y, o] = corners[i]!;
    const p = world[i]!;
    b.pos.push(p.x, p.y, p.z);
    b.nrm.push(toSnorm(n[0]), toSnorm(n[1]), toSnorm(n[2]));
    // World-metre uvs: along the wall line (the painted grid's u) and height; step faces run
    // their short side over the depth.
    const u = f.sa + s + (q.axis === 's' ? o : 0);
    const v = uvY(y) + (q.axis === 'y' ? o : 0);
    b.uv.push(u, v);
    b.col.push(colour.r, colour.g, colour.b);
    b.palace.push(f.style === 'monumental' ? 255 : 0);
    b.panel.push(panel && q.axis === 'o' ? 255 : 0);
    b.cavity.push(cavityVisibility(q, o, f.style === 'monumental'));
    if (b.uv1) {
      const [a, c] = lm ? lm(p) : [0, 0];
      b.uv1.push(toUnorm16(a), toUnorm16(c));
    }
  }
  // Counter-clockwise seen from the normal side.
  const e1 = [world[1]!.x - world[0]!.x, world[1]!.y - world[0]!.y, world[1]!.z - world[0]!.z];
  const e2 = [world[2]!.x - world[0]!.x, world[2]!.y - world[0]!.y, world[2]!.z - world[0]!.z];
  const cx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
  const cy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
  const cz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) {
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  } else {
    b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

/** World bounds of a face segment (its rectangle swept over the relief depth). */
function segmentBox(f: FacadeFace, box: { x0: number; x1: number; y0: number; y1: number }) {
  const b = new THREE.Box3();
  for (const s of [box.x0, box.x1]) {
    for (const o of [RELIEF_MIN, 0]) {
      const x = f.ax + f.dx * s + f.dz * o;
      const z = f.az + f.dz * s - f.dx * o;
      b.expandByPoint(new THREE.Vector3(x, box.y0, z));
      b.expandByPoint(new THREE.Vector3(x, box.y1, z));
    }
  }
  return b;
}

/** A built facade: merged material meshes and per-cell distance LOD. */
export class FacadeDetail extends THREE.Group {
  readonly meshes: Partial<Record<MeshKind, THREE.Mesh>> = {};
  readonly shadowMesh: THREE.Mesh;
  /** Material swaps for baked lighting (empty when the map has no bake). */
  readonly swaps: { mesh: THREE.Mesh; baked: THREE.Material; plain: THREE.Material }[] = [];
  private readonly sourceIndices: Partial<Record<MeshKind, Uint16Array | Uint32Array>> = {};
  private readonly cameraPosition = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private lod = FACADE_LOD.high;

  constructor(
    readonly cells: Cell[],
    faces: readonly FacadeFace[],
    materials: MapMaterials,
    bake: FacadeBake | null,
  ) {
    super();
    this.name = 'facadeDetail';
    const shadow = new PartBuilder(false);
    const shadowColour = new THREE.Color(1, 1, 1);
    for (const f of faces)
      emitQuad(
        shadow,
        f,
        {
          axis: 'o',
          sign: 1,
          x0: 0,
          x1: f.len,
          y0: f.y0,
          y1: f.y1,
          o0: 0,
          o1: 0,
          kind: 0,
          seg: 0,
        },
        shadowColour,
        null,
      );
    this.shadowMesh = new THREE.Mesh(
      shadow.build(),
      new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
    );
    this.shadowMesh.name = 'facade:shadow-proxy';
    this.shadowMesh.castShadow = true;
    this.shadowMesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.BackSide,
    });
    this.shadowMesh.receiveShadow = false;
    this.shadowMesh.matrixAutoUpdate = false;
    this.add(this.shadowMesh);
    for (const kind of ['shell', 'glass', 'paint'] as const) {
      const merged = new PartBuilder(bake !== null);
      for (const c of cells) {
        for (const part of PARTS) {
          const b = c.builders[part];
          if (PART_MESH[part] !== kind || !b || !b.idx.length) continue;
          const base = merged.vertexCount;
          c.ranges[part] = { start: merged.idx.length, count: b.idx.length };
          // Avoid argument-count limits on large Palace buffers.
          for (const v of b.pos) merged.pos.push(v);
          for (const v of b.nrm) merged.nrm.push(v);
          for (const v of b.uv) merged.uv.push(v);
          for (const v of b.col) merged.col.push(v);
          for (const v of b.cavity) merged.cavity.push(v);
          for (const v of b.palace) merged.palace.push(v);
          for (const v of b.panel) merged.panel.push(v);
          if (merged.uv1 && b.uv1) for (const v of b.uv1) merged.uv1.push(v);
          for (const i of b.idx) merged.idx.push(base + i);
        }
      }
      if (!merged.idx.length) continue;
      const geometry = merged.build();
      const indices = geometry.getIndex()!;
      this.sourceIndices[kind] = (indices.array as Uint16Array | Uint32Array).slice();
      indices.setUsage(THREE.DynamicDrawUsage);
      const surface = MESH_SURFACE[kind];
      const plain =
        kind === 'shell'
          ? materials.facadeShellVariant('facadeDetail', () => {})
          : materials.variant(surface, 'facadeDetail', () => {});
      // Walkable-block walls weather (grime, sill streaks, staining; the backdrop skyline, far
      // away, stays plain); windows get rooms behind the glass on panes and painted panels.
      if (kind !== 'glass') addFacadeWeathering(plain, { windows: kind === 'paint' });
      if (kind !== 'glass')
        addPalaceEntranceStone(plain, { facade: true, windows: kind === 'paint' });
      if (kind !== 'glass') plain.userData.keepNormalOnLow = true;
      if (kind !== 'shell') addWindowInteriors(plain);
      const mesh = new THREE.Mesh(geometry, plain);
      mesh.name = `facade:${kind}`;
      // Relief details are view decoration; the cheap flat proxy above owns facade shadows.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.meshes[kind] = mesh;
      this.add(mesh);
      if (bake) {
        const baked =
          kind === 'shell'
            ? materials.facadeShellVariant(`facadeDetail|${bake.key}`, (m) => {
                m.aoMap = bake.tex;
                m.aoMapIntensity = bake.intensity;
              })
            : materials.variant(surface, `facadeDetail|${bake.key}`, (m) => {
                m.aoMap = bake.tex;
                m.aoMapIntensity = bake.intensity;
              });
        if (kind !== 'glass') addFacadeWeathering(baked, { windows: kind === 'paint' });
        if (kind !== 'glass')
          addPalaceEntranceStone(baked, { facade: true, windows: kind === 'paint' });
        if (kind !== 'glass') baked.userData.keepNormalOnLow = true;
        if (kind !== 'shell') addWindowInteriors(baked);
        this.swaps.push({ mesh, baked, plain });
      }
    }
    for (const c of cells) c.builders = {};
    this.selectIndices();
  }

  /** Level-of-detail distances for a quality tier (no shader or vertex-buffer changes). */
  setQuality(q: ResolvedQuality): void {
    this.lod = FACADE_LOD[q];
  }

  /** Reflective glass keeps IBL on Low without enabling environment fetches on every wall. */
  setEnvironment(environment: THREE.Texture | null, intensity: number): void {
    const glass = this.meshes.glass;
    if (!glass) return;
    const swap = this.swaps.find((s) => s.mesh === glass);
    const materials = swap ? [swap.plain, swap.baked] : [glass.material];
    for (const material of materials) {
      const mat = material as THREE.MeshStandardMaterial;
      if (Boolean(mat.envMap) !== Boolean(environment)) mat.needsUpdate = true;
      mat.envMap = environment;
      mat.envMapIntensity = intensity;
    }
  }

  /** Compile all facade variants against the real lights/environment before entering play. */
  async warmUp(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene,
  ): Promise<void> {
    const toneMapping = renderer.toneMapping;
    const outputColorSpace = renderer.outputColorSpace;
    const original = this.swaps.map(({ mesh }) => mesh.material);
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    const depthTarget = new THREE.WebGLRenderTarget(1, 1);
    const depthProxy = new THREE.Mesh(
      this.shadowMesh.geometry,
      this.shadowMesh.customDepthMaterial ?? undefined,
    );
    const depthRoot = new THREE.Group();
    depthRoot.name = 'facade:shadow-warmup';
    depthRoot.add(depthProxy);
    try {
      renderer.setRenderTarget(depthTarget);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      await renderer.compileAsync(depthRoot, camera, scene);
      renderer.setRenderTarget(target, face, level);
      for (const mode of [THREE.NoToneMapping, THREE.AgXToneMapping]) {
        renderer.toneMapping = mode;
        // Medium+ renders into a linear HDR target; Low writes directly to the sRGB canvas.
        renderer.outputColorSpace =
          mode === THREE.NoToneMapping ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
        for (const { mesh, plain } of this.swaps) mesh.material = plain;
        await renderer.compileAsync(this, camera, scene);
        if (this.swaps.length) {
          for (const { mesh, baked } of this.swaps) mesh.material = baked;
          await renderer.compileAsync(this, camera, scene);
        }
      }
    } finally {
      renderer.setRenderTarget(target, face, level);
      depthTarget.dispose();
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      this.swaps.forEach(({ mesh }, i) => {
        mesh.material = original[i]!;
      });
    }
  }

  /** No allocation or uploads unless a cell crosses its hysteresis threshold. */
  update(cam: { x: number; y: number; z: number }, camera?: THREE.Camera): void {
    const { near, mid } = this.lod;
    this.cameraPosition.set(cam.x, cam.y, cam.z);
    if (camera) {
      camera.updateWorldMatrix(true, false);
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewProjection);
    }
    let changed = false;
    for (const c of this.cells) {
      const visible = !camera || this.frustum.intersectsBox(c.box);
      if (visible !== c.visible) {
        c.visible = visible;
        changed = true;
      }
      const d = c.box.distanceToPoint(this.cameraPosition);
      const n = c.lod === 0 ? near + FACADE_LOD_HYSTERESIS : near;
      const m = c.lod <= 1 ? mid + FACADE_LOD_HYSTERESIS : mid;
      const want = d < n ? 0 : d < m ? 1 : 2;
      if (want !== c.lod) {
        c.lod = want;
        changed = true;
      }
    }
    if (changed) this.selectIndices();
  }

  /** Cells per level of detail (tests, perf overlay). */
  lodCounts(): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (const c of this.cells) out[c.lod]++;
    return out;
  }

  private selectIndices(): void {
    for (const kind of ['shell', 'glass', 'paint'] as const) {
      const mesh = this.meshes[kind];
      if (!mesh) continue;
      const source = this.sourceIndices[kind]!;
      const index = mesh.geometry.getIndex()!;
      const target = index.array as Uint16Array | Uint32Array;
      let count = 0;
      for (const c of this.cells) {
        if (!c.visible) continue;
        const parts = LOD_PARTS[c.lod]!;
        for (const part of parts) {
          const range = c.ranges[part];
          if (PART_MESH[part] !== kind || !range) continue;
          target.set(source.subarray(range.start, range.start + range.count), count);
          count += range.count;
        }
      }
      mesh.geometry.setDrawRange(0, count);
      index.clearUpdateRanges();
      if (count > 0) {
        index.addUpdateRange(0, count);
        index.needsUpdate = true;
      }
    }
  }
}

const LOD_PARTS: readonly (readonly FacadePart[])[] = [
  ['frame', 'detail', 'glass'],
  ['frame', 'panel'],
  ['frame', 'panel'],
];

/**
 * Build the facade detail of every relief prism of `map` (see `isReliefPrism`: their walls are
 * not in the flat map mesh). Null when the map has none.
 */
export function buildFacadeDetail(
  map: MapDefinition,
  materials: MapMaterials,
  bake: FacadeBake | null = null,
): FacadeDetail | null {
  const faces = facadeFaces(map, PALACE_TINT);
  if (!faces.length) return null;
  const cells = new Map<string, Cell>();
  const tint = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  const crowns = palaceCrowns(faces, map.prisms ?? []).map((crown) => ({
    crown,
    geometry: palaceCrownGeometry(crown),
  }));
  const roofRoots = new Map<number, Map<string, readonly [number, number]>>();
  for (const { crown, geometry } of crowns) {
    const roots = roofRoots.get(crown.face.y1) ?? new Map<string, readonly [number, number]>();
    for (let i = 0; i < geometry.frame.pos.length; i += 3) {
      if (geometry.frame.pos[i + 1] !== crown.face.y1) continue;
      const x = geometry.frame.pos[i]!;
      const z = geometry.frame.pos[i + 2]!;
      roots.set(`${coordKey(x)},${coordKey(z)}`, [x, z]);
    }
    roofRoots.set(crown.face.y1, roots);
  }
  for (const f of faces) {
    if (isPalaceSpire(map.prisms![f.prism]!)) continue;
    if (f.tint !== undefined) tint.setHex(f.tint, THREE.SRGBColorSpace);
    const colour = f.tint !== undefined ? tint : white;
    const lm = bake ? bake.uvFor(f.prism, f.edge) : null;
    const segs = faceRelief(f);
    const edgeBreaks = collectFrontBreaks(segs);
    // A seated cap can add vertices along the perpendicular wall's roof edge. Share those
    // subdivisions with the existing wall triangulation instead of leaving T-junctions.
    const plane = edgeBreaks.get(coordKey(0));
    if (plane) {
      for (const [x, z] of roofRoots.get(f.y1)?.values() ?? []) {
        const o = (x - f.ax) * f.dz - (z - f.az) * f.dx;
        const s = (x - f.ax) * f.dx + (z - f.az) * f.dz;
        if (Math.abs(o) < EDGE_EPS && s > 0 && s < f.len) addBreak(plane.xsByY, coordKey(f.y1), s);
      }
    }
    for (const seg of segs) {
      const box = segmentBox(f, seg.box);
      const centre = box.getCenter(new THREE.Vector3());
      const key = `${Math.floor(centre.x / FACADE_CELL)},${Math.floor(centre.z / FACADE_CELL)},${Math.floor(centre.y / FACADE_CELL_Y)}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { key, box: new THREE.Box3(), lod: 2, visible: true, ranges: {}, builders: {} };
        cells.set(key, cell);
      }
      cell.box.union(box);
      for (const part of PARTS) {
        const quads = seg.parts[part];
        if (!quads.length) continue;
        const b = (cell.builders[part] ??= new PartBuilder(bake !== null));
        const c = part === 'glass' ? PANE : colour;
        for (const q of quads)
          emitQuad(b, f, q, c, lm, edgeBreaks, part === 'detail' || part === 'panel');
      }
    }
  }
  const addStone = (geometry: PalaceStoneGeometry, part: 'frame' | 'detail'): void => {
    if (!geometry.idx.length) return;
    const box = new THREE.Box3();
    for (let i = 0; i < geometry.pos.length; i += 3) {
      box.expandByPoint(
        new THREE.Vector3(geometry.pos[i], geometry.pos[i + 1], geometry.pos[i + 2]),
      );
    }
    const centre = box.getCenter(new THREE.Vector3());
    const key = `${Math.floor(centre.x / FACADE_CELL)},${Math.floor(centre.z / FACADE_CELL)},${Math.floor(centre.y / FACADE_CELL_Y)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, box: new THREE.Box3(), lod: 2, visible: true, ranges: {}, builders: {} };
      cells.set(key, cell);
    }
    cell.box.union(box);
    const builder = (cell.builders[part] ??= new PartBuilder(bake !== null));
    emitStoneGeometry(builder, geometry, bake?.unbakedUv ?? null);
  };
  for (const { geometry } of crowns) {
    addStone(geometry.frame, 'frame');
    addStone(geometry.detail, 'detail');
  }
  for (const clock of palaceClockGeometry(faces)) addStone(clock, 'frame');
  const spire = palaceSpireGeometry(faces);
  if (spire) addStone(spire, 'frame');
  return new FacadeDetail([...cells.values()], faces, materials, bake);
}

/** The facade detail built into a map group (Game drives its LOD). */
export function findFacadeDetail(root: THREE.Object3D): FacadeDetail | null {
  let found: FacadeDetail | null = null;
  root.traverse((o) => {
    if (!found && o instanceof FacadeDetail) found = o;
  });
  return found;
}
