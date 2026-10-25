/**
 * The armored 4x4's look. Until the art lane's glTF lands (`/models/vehicles/truck.glb`, same node
 * layout), a placeholder built from boxes and cylinders with exactly the model contract's nodes
 * (`truckSpec.ts`): `body`, `wheel_fl/fr/rl/rr` (pivot at the wheel centre, roll about local X),
 * `seat_driver` / `seat_front` / `seat_rear_l` / `seat_rear_r`, `exit_l` / `exit_r`. Front +Z,
 * origin on the ground between the axles. Presentation only: the sim never reads it.
 *
 * Draw cost: the body is merged per material (armour, trim, glass) — 3 draws — plus 4 wheels
 * (tyre + hub in one vertex-coloured geometry each).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  BED_FLOOR,
  BED_WALL_TOP,
  BELTLINE,
  CAB_BACK,
  CAB_FRONT,
  EXIT_POS,
  ROOF,
  SEAT_NODE,
  SEAT_SPEC,
  SEATS,
  TRUCK,
  WHEEL_POS,
  WHEELS,
  WINDSCREEN_TOP,
  type WheelId,
} from '@wd/shared';

export const WHEEL_NODE: Readonly<Record<WheelId, string>> = {
  fl: 'wheel_fl',
  fr: 'wheel_fr',
  rl: 'wheel_rl',
  rr: 'wheel_rr',
};

/** Shared materials (one program each, compiled at warm-up). */
export interface TruckMaterials {
  armour: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
}

export function truckMaterials(): TruckMaterials {
  return {
    // Matte graphite-olive armour (the near-future look: no camo, no markings).
    armour: new THREE.MeshStandardMaterial({ color: 0x5b6352, roughness: 0.72, metalness: 0.3 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.6, metalness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0x22313a,
      roughness: 0.08,
      metalness: 0.2,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
    }),
    tyre: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.1,
    }),
  };
}

const box = (
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
};

const HW = TRUCK.width / 2;
const HL = TRUCK.length / 2;

function armourGeometry(): THREE.BufferGeometry {
  const parts = [
    box(-HW, 0.5, -HL, HW, BED_FLOOR, HL), // chassis + bed floor
    box(-HW, BED_FLOOR, CAB_BACK, HW, BELTLINE, CAB_FRONT), // cab doors
    box(-HW + 0.04, BED_FLOOR, CAB_FRONT, HW - 0.04, BELTLINE - 0.06, HL - 0.05), // bonnet
    box(-HW + 0.06, ROOF, CAB_BACK, HW - 0.06, TRUCK.height, WINDSCREEN_TOP), // roof
    box(-HW, BELTLINE, CAB_BACK, HW, ROOF, CAB_BACK + 0.12), // cab back wall
    box(HW - 0.1, BELTLINE, WINDSCREEN_TOP, HW, ROOF, CAB_FRONT), // A-pillars
    box(-HW, BELTLINE, WINDSCREEN_TOP, -HW + 0.1, ROOF, CAB_FRONT),
    box(HW - 0.1, BELTLINE, CAB_BACK, HW, ROOF, CAB_BACK + 0.2), // B-pillars
    box(-HW, BELTLINE, CAB_BACK, -HW + 0.1, ROOF, CAB_BACK + 0.2),
    box(HW - 0.08, BED_FLOOR, -HL, HW, BED_WALL_TOP, CAB_BACK), // bed walls
    box(-HW, BED_FLOOR, -HL, -HW + 0.08, BED_WALL_TOP, CAB_BACK),
    box(-HW, BED_FLOOR, -HL, HW, BED_WALL_TOP, -HL + 0.08), // tailgate
    // Wheel arches over each tyre.
    ...WHEELS.map((w) => {
      const c = WHEEL_POS[w];
      const s = Math.sign(c.x);
      return box(
        s > 0 ? HW - 0.02 : -HW - 0.06,
        c.y + TRUCK.wheelRadius - 0.02,
        c.z - 0.6,
        s > 0 ? HW + 0.06 : -HW + 0.02,
        c.y + TRUCK.wheelRadius + 0.1,
        c.z + 0.6,
      );
    }),
  ];
  return mergeGeometries(parts);
}

function trimGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    box(-HW - 0.03, 0.42, HL - 0.05, HW + 0.03, 0.78, HL + 0.18), // front bumper / ram bar
    box(-HW + 0.15, 0.42, -HL - 0.12, HW - 0.15, 0.7, -HL + 0.02), // rear bumper
    box(-0.6, 0.85, HL - 0.02, 0.6, 1.25, HL + 0.02), // grille
    box(-HW + 0.15, 0.22, -1.2, HW - 0.15, 0.5, 1.2), // under-armour skid plate
    // Bed benches (the rear seats sit on these).
    box(0.25, BED_FLOOR, -2.2, 0.85, SEAT_SPEC.rearL.hip.y - 0.05, -0.5),
    box(-0.85, BED_FLOOR, -2.2, -0.25, SEAT_SPEC.rearR.hip.y - 0.05, -0.5),
    // Cab seats.
    box(0.2, CAB_FLOOR_Y, -0.05, 0.7, SEAT_SPEC.driver.hip.y - 0.02, 0.45),
    box(-0.7, CAB_FLOOR_Y, -0.05, -0.2, SEAT_SPEC.front.hip.y - 0.02, 0.45),
  ]);
}
const CAB_FLOOR_Y = SEAT_SPEC.driver.floor;

function glassGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    box(-HW + 0.1, BELTLINE, CAB_FRONT - 0.05, HW - 0.1, ROOF, CAB_FRONT), // windscreen
    box(HW - 0.04, BELTLINE, CAB_BACK + 0.2, HW - 0.01, ROOF, WINDSCREEN_TOP), // side windows
    box(-HW + 0.01, BELTLINE, CAB_BACK + 0.2, -HW + 0.04, ROOF, WINDSCREEN_TOP),
  ]);
}

/** Paint a geometry one vertex colour (wheels: one draw for tyre + hub). */
function tint(g: THREE.BufferGeometry, v: number): THREE.BufferGeometry {
  const n = g.attributes.position!.count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array<number>(n * 3).fill(v), 3));
  return g;
}

/**
 * Tyre, hub and a lug bar merged into one geometry (vertex-coloured, one draw per wheel); the
 * hub's six flats and the bar make the spin read. Axis along X: rolls about local X.
 */
function wheelGeometry(): THREE.BufferGeometry {
  const tyre = new THREE.CylinderGeometry(
    TRUCK.wheelRadius,
    TRUCK.wheelRadius,
    TRUCK.tyreWidth,
    18,
  );
  const hub = new THREE.CylinderGeometry(0.24, 0.24, TRUCK.tyreWidth + 0.03, 6);
  const bar = new THREE.BoxGeometry(0.4, TRUCK.tyreWidth + 0.04, 0.08);
  const g = mergeGeometries([
    tint(tyre.toNonIndexed(), 0.06),
    tint(hub.toNonIndexed(), 0.32),
    tint(bar.toNonIndexed(), 0.22),
  ]);
  g.rotateZ(Math.PI / 2);
  return g;
}

/**
 * The placeholder truck: a group with the contract's node names. Geometry is shared between
 * trucks (build once, `clone()` per truck shares it too).
 */
export function buildTruckPlaceholder(mats: TruckMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'truck';
  const body = new THREE.Group();
  body.name = 'body';
  const armour = new THREE.Mesh(armourGeometry(), mats.armour);
  const trim = new THREE.Mesh(trimGeometry(), mats.trim);
  const glass = new THREE.Mesh(glassGeometry(), mats.glass);
  glass.name = 'glass';
  for (const m of [armour, trim]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  glass.renderOrder = 2;
  body.add(armour, trim, glass);
  root.add(body);
  const wheel = wheelGeometry();
  for (const w of WHEELS) {
    const node = new THREE.Group();
    node.name = WHEEL_NODE[w];
    const c = WHEEL_POS[w];
    node.position.set(c.x, c.y, c.z);
    const t = new THREE.Mesh(wheel, mats.tyre);
    t.castShadow = true;
    node.add(t);
    root.add(node);
  }
  for (const s of SEATS) {
    const e = new THREE.Object3D();
    e.name = SEAT_NODE[s];
    const p = SEAT_SPEC[s].hip;
    e.position.set(p.x, p.y, p.z);
    root.add(e);
  }
  for (const side of ['l', 'r'] as const) {
    const e = new THREE.Object3D();
    e.name = `exit_${side}`;
    const p = EXIT_POS[side];
    e.position.set(p.x, p.y, p.z);
    root.add(e);
  }
  return root;
}

/** Every node the model contract requires (a loaded glTF must have them all). */
export const REQUIRED_NODES: readonly string[] = [
  'body',
  ...WHEELS.map((w) => WHEEL_NODE[w]),
  ...SEATS.map((s) => SEAT_NODE[s]),
  'exit_l',
  'exit_r',
];

/** Whether a model has the contract's node layout. */
export function hasTruckLayout(root: THREE.Object3D): boolean {
  return REQUIRED_NODES.every((n) => root.getObjectByName(n) !== undefined);
}
