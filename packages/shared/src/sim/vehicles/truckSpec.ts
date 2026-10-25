/**
 * The armored 4x4 truck: one shared spec for the physics, the server, the client and the tests.
 *
 * Model contract (the art lane's glTF follows it; the client's placeholder is built from it):
 * Y-up, front +Z, origin on the ground at the centre between the axles. Body 5.0 × 2.1 × ≈2.0 m,
 * wheelbase 3.1 m, track 1.75 m, wheel radius 0.46 m, tyre width 0.32 m. Nodes `body`,
 * `wheel_fl/fr/rl/rr` (pivot at the wheel centre, roll about local X), empties `seat_driver`
 * (front-left), `seat_front`, `seat_rear_l`, `seat_rear_r` (seated hip height, facing +Z),
 * `exit_l`, `exit_r`. Front cab enclosed with glass; open cargo bed at the rear. The destroyed
 * variant shares the node layout.
 *
 * Local frame: +Z forward, +Y up, +X = the vehicle's LEFT (facing +Z, right-handed Y-up: right
 * is -X). So the driver (front-left) sits at +X.
 */
import type { Vec3 } from '../../math/vec3.ts';

export const TRUCK = {
  /** Body length / width / height (m). */
  length: 5.0,
  width: 2.1,
  height: 2.0,
  wheelbase: 3.1,
  track: 1.75,
  wheelRadius: 0.46,
  tyreWidth: 0.32,
} as const;

export type WheelId = 'fl' | 'fr' | 'rl' | 'rr';
export const WHEELS: readonly WheelId[] = ['fl', 'fr', 'rl', 'rr'];

/** Wheel centres at rest (local): front axle +Z, left side +X. */
export const WHEEL_POS: Readonly<Record<WheelId, Vec3>> = {
  fl: { x: TRUCK.track / 2, y: TRUCK.wheelRadius, z: TRUCK.wheelbase / 2 },
  fr: { x: -TRUCK.track / 2, y: TRUCK.wheelRadius, z: TRUCK.wheelbase / 2 },
  rl: { x: TRUCK.track / 2, y: TRUCK.wheelRadius, z: -TRUCK.wheelbase / 2 },
  rr: { x: -TRUCK.track / 2, y: TRUCK.wheelRadius, z: -TRUCK.wheelbase / 2 },
};

/** Seats in wire order (`SnapshotPlayer.vh` carries the index). Append-only. */
export const SEATS = ['driver', 'front', 'rearL', 'rearR'] as const;
export type SeatId = (typeof SEATS)[number];
export const SEAT_NODE: Readonly<Record<SeatId, string>> = {
  driver: 'seat_driver',
  front: 'seat_front',
  rearL: 'seat_rear_l',
  rearR: 'seat_rear_r',
};

export interface SeatSpec {
  /** Seated hip point (local; the glTF empty). */
  hip: Vec3;
  /** Floor under the occupant (local y): the occupant's `pos` (feet) for hit volumes. */
  floor: number;
  /** Eye above the floor (m): crouch-scaled humanoid volumes then sit like a seated body. */
  eye: number;
  /** In the enclosed cab (protected by doors, glass lets some through) or the open bed. */
  cab: boolean;
  /** Side the occupant gets out on. */
  exit: 'l' | 'r';
  /**
   * The upper body leans this far sideways from the hip (local x, m): the front gunner leans to
   * its window (a wider view and field of fire, and more of it exposed). Feet and eye shift too.
   */
  lean?: number;
}

/** Cab floor and the cargo bed floor (local y). */
export const CAB_FLOOR = 0.91;
export const BED_FLOOR = 1.08;

export const SEAT_SPEC: Readonly<Record<SeatId, SeatSpec>> = {
  // Cab (the art lane's model): eye 1.83 m over the ground, above the beltline (1.62) and under
  // the roof (1.94): seated, looking out of the glass; the windscreen 0.6–0.95 m ahead.
  driver: { hip: { x: 0.45, y: 1.2, z: 0.15 }, floor: CAB_FLOOR, eye: 0.92, cab: true, exit: 'l' },
  front: {
    hip: { x: -0.45, y: 1.2, z: 0.15 },
    floor: CAB_FLOOR,
    eye: 0.92,
    cab: true,
    exit: 'r',
    lean: -0.32,
  },
  rearL: { hip: { x: 0.55, y: 1.5, z: -1.35 }, floor: BED_FLOOR, eye: 1.12, cab: false, exit: 'l' },
  rearR: {
    hip: { x: -0.55, y: 1.5, z: -1.35 },
    floor: BED_FLOOR,
    eye: 1.12,
    cab: false,
    exit: 'r',
  },
};

/** Exit points (feet, local): beside the cab doors, clear of the body by a capsule radius. */
export const EXIT_POS: Readonly<Record<'l' | 'r', Vec3>> = {
  l: { x: 1.55, y: 0, z: 0.3 },
  r: { x: -1.55, y: 0, z: 0.3 },
};

/** An axis-aligned box in the vehicle's local frame. */
export interface LocalBox {
  min: Vec3;
  max: Vec3;
}
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): LocalBox => ({
  min: { x: x0, y: y0, z: z0 },
  max: { x: x1, y: y1, z: z1 },
});

const HW = TRUCK.width / 2;
const HL = TRUCK.length / 2;
/** Cab rear wall, the windscreen's top (roof edge) and its foot at the bonnet (local z). */
export const CAB_BACK = -0.3;
export const WINDSCREEN_TOP = 0.75;
export const CAB_FRONT = 1.1;
/** Door beltline (window bottom) and cab roof (local y). */
export const BELTLINE = 1.62;
export const ROOF = 1.94;
/** Cargo bed wall top (local y). */
export const BED_WALL_TOP = 1.55;

/**
 * Armour the bullets stop at (local boxes): lower hull, cab doors + bonnet up to the beltline,
 * cab roof and pillars, bed walls and tailgate, wheels. The cab windows are the gaps between them
 * (glass: rounds get through, weakened, `VEHICLE.glassDamage`); the bed is open above its walls.
 */
export const HULL_BOXES: readonly LocalBox[] = [
  box(-HW, 0.42, -HL, HW, BED_FLOOR, HL), // chassis + bed floor
  box(-HW, BED_FLOOR, CAB_BACK, HW, BELTLINE, HL), // cab doors and bonnet
  box(-HW + 0.06, ROOF, CAB_BACK, HW - 0.06, TRUCK.height, WINDSCREEN_TOP), // roof
  box(-HW, BELTLINE, CAB_BACK, HW, ROOF, CAB_BACK + 0.12), // cab back wall (armoured, slit)
  box(HW - 0.1, BELTLINE, WINDSCREEN_TOP, HW, ROOF, CAB_FRONT), // A-pillar left
  box(-HW, BELTLINE, WINDSCREEN_TOP, -HW + 0.1, ROOF, CAB_FRONT), // A-pillar right
  box(HW - 0.08, BED_FLOOR, -HL, HW, BED_WALL_TOP, CAB_BACK), // bed wall left
  box(-HW, BED_FLOOR, -HL, -HW + 0.08, BED_WALL_TOP, CAB_BACK), // bed wall right
  box(-HW, BED_FLOOR, -HL, HW, BED_WALL_TOP, -HL + 0.08), // tailgate
  ...(['fl', 'fr', 'rl', 'rr'] as const).map((w) => {
    const c = WHEEL_POS[w];
    const r = TRUCK.wheelRadius;
    const t = TRUCK.tyreWidth / 2;
    return box(c.x - t, 0, c.z - r, c.x + t, c.y + r, c.z + r);
  }),
];

/**
 * The volume swept against the static world (local): the whole body above the step the wheels
 * can climb (`VEHICLE.maxStep`): lower lips are climbed by the wheels, anything taller is a wall.
 */
export function collisionBox(maxStep: number): LocalBox {
  return box(-HW, maxStep, -HL, HW, TRUCK.height - 0.05, HL);
}
