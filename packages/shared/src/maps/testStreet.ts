import { block, boxMinMax, ramp, stairs, wall } from './builder.ts';
import type { MapBox, MapDefinition } from './types.ts';

/**
 * M1 greybox test street (80 × 120 m). Axes: +X east, +Z south, +Y up. The player spawns at the
 * south end looking north (yaw 0 = -Z).
 *
 * Zones, south → north:
 *   z 44..52  spawn, step-height test blocks (0.40 m climbable, 0.55 m needs a jump)
 *   z 34..42  low walls (crouch cover) + crawl gap (crouch-only clearance)
 *   z 22..34  crate field, shipping container, barriers
 *   z  9..22  ramps at 15°, 30°, 45° (climbable), 55° (slides) onto a 2 m platform + stairs
 *   z -14..2  east: two-storey building (stairwell, upper floor, street balcony)
 *   z -50..-5 firing range: static, moving, crouched, and upper-floor dummies
 */
function build(): MapDefinition {
  const boxes: MapBox[] = [];
  const add = (...b: MapBox[]): void => {
    boxes.push(...b);
  };

  // --- Ground, sidewalks, bounds ------------------------------------------------------------
  add(boxMinMax({ x: -40, y: -1, z: -60 }, { x: 40, y: 0, z: 60 }, 'asphalt'));
  add(boxMinMax({ x: -13, y: 0, z: -60 }, { x: -9, y: 0.15, z: 60 }, 'sidewalk'));
  add(boxMinMax({ x: 9, y: 0, z: -60 }, { x: 13, y: 0.15, z: 60 }, 'sidewalk'));
  const bound = { collide: true, visible: false } as const;
  add(boxMinMax({ x: -41, y: -1, z: -61 }, { x: -40, y: 40, z: 61 }, 'concrete', bound));
  add(boxMinMax({ x: 40, y: -1, z: -61 }, { x: 41, y: 40, z: 61 }, 'concrete', bound));
  add(boxMinMax({ x: -41, y: -1, z: -61 }, { x: 41, y: 40, z: -60 }, 'concrete', bound));
  add(boxMinMax({ x: -41, y: -1, z: 60 }, { x: 41, y: 40, z: 61 }, 'concrete', bound));

  // Backdrop facades (solid blocks with alley gaps).
  const west: [number, number, number][] = [
    [-60, -35, 12],
    [-30, -5, 18],
    [5, 30, 10],
    [35, 60, 15],
  ];
  for (const [z0, z1, h] of west) {
    add(boxMinMax({ x: -40, y: 0, z: z0 }, { x: -13, y: h, z: z1 }, 'plaster'));
  }
  add(boxMinMax({ x: 13, y: 0, z: -60 }, { x: 40, y: 14, z: -20 }, 'plaster'));
  add(boxMinMax({ x: 13, y: 0, z: 15 }, { x: 40, y: 11, z: 60 }, 'plaster'));
  add(boxMinMax({ x: 27, y: 0, z: -20 }, { x: 40, y: 9, z: 15 }, 'plaster'));

  // --- Spawn: step-height tests ------------------------------------------------------------
  add(block(4, 48, 0, 1.5, 0.4, 1.5, 'accent'));
  add(block(6.5, 48, 0, 1.5, 0.55, 1.5, 'trim'));

  // --- Crouch cover + crawl gap ------------------------------------------------------------
  add(boxMinMax({ x: -6, y: 0, z: 39.8 }, { x: -2, y: 1.0, z: 40.2 }, 'concrete'));
  add(boxMinMax({ x: 2, y: 0, z: 39.8 }, { x: 5, y: 1.0, z: 40.2 }, 'concrete'));
  // Crawl gap: slab at 1.35 m on posts. Standing (1.8) is blocked, crouching (1.2) fits.
  add(boxMinMax({ x: 5.5, y: 1.35, z: 34 }, { x: 8.5, y: 1.7, z: 38 }, 'concrete'));
  for (const [x, z] of [
    [5.5, 34],
    [8.2, 34],
    [5.5, 37.7],
    [8.2, 37.7],
  ] as const) {
    add(boxMinMax({ x, y: 0, z }, { x: x + 0.3, y: 1.35, z: z + 0.3 }, 'metal'));
  }

  // --- Crate field -------------------------------------------------------------------------
  const crates: [number, number, number][] = [
    [-6, 30, 0],
    [-4.6, 30.4, 0],
    [-6, 30, 1.2],
    [1, 26, 0],
    [2.2, 26, 0],
    [4, 31, 0],
    [7, 24, 0],
    [-2, 23, 0],
  ];
  for (const [x, z, y] of crates) add({ ...block(x, z, y, 1.2, 1.2, 1.2, 'wood'), model: 'crate' });
  add(block(-1, 30, 0, 2.4, 2.6, 6, 'metal')); // shipping container
  // Jersey barriers.
  add({ ...block(5, 28, 0, 3, 0.9, 0.6, 'concrete', 20), model: 'jersey' });
  add({ ...block(-7, 25, 0, 3, 0.9, 0.6, 'concrete', -35), model: 'jersey' });

  // --- Ramps onto a 2 m platform -----------------------------------------------------------
  const platTop = 2;
  add(boxMinMax({ x: -9, y: 0, z: 9 }, { x: 3, y: platTop, z: 12.5 }, 'concrete'));
  for (const [x, deg] of [
    [-7.5, 15],
    [-4.5, 30],
    [-1.5, 45],
    [1.5, 55],
  ] as const) {
    const run = platTop / Math.tan((deg * Math.PI) / 180);
    add(ramp({ x, y: 0, z: 12.5 + run }, '-z', run, platTop, 2.6, 'trim'));
  }
  add(...stairs({ x: 6.5, y: 0, z: 10.75 }, '-x', 3.5, platTop, 2, 'concrete'));

  // --- Two-storey building (x 13..27, z -14..2) --------------------------------------------
  const x0 = 13;
  const x1 = 27;
  const z0 = -14;
  const z1 = 2;
  const f1 = 0.15; // ground floor top (sidewalk level)
  const f2 = 3.6; // upper floor top
  const storey = f2 - f1 - 0.15; // wall height up to the slab underside
  const t = 0.3;
  const win = (from: number): { from: number; to: number; bottom: number; top: number } => ({
    from,
    to: from + 2,
    bottom: 1.0,
    top: 2.2,
  });
  const door = (
    from: number,
    w = 1.6,
  ): { from: number; to: number; bottom: number; top: number } => ({
    from,
    to: from + w,
    bottom: 0,
    top: 2.3,
  });
  // Ground floor
  add(boxMinMax({ x: x0, y: 0, z: z0 }, { x: x1, y: f1, z: z1 }, 'concrete'));
  add(
    ...wall({ x: x0, z: z0 }, { x: x0, z: z1 }, f1, storey, t, 'plaster', [
      win(2),
      door(7),
      win(11.5),
    ]),
  );
  add(...wall({ x: x1, z: z0 }, { x: x1, z: z1 }, f1, storey, t, 'plaster', [door(12, 1.4)]));
  add(...wall({ x: x0, z: z0 }, { x: x1, z: z0 }, f1, storey, t, 'plaster', [win(8)]));
  add(...wall({ x: x0, z: z1 }, { x: x1, z: z1 }, f1, storey, t, 'plaster', [door(3), win(9)]));
  add(...wall({ x: x0, z: -5 }, { x: 20, z: -5 }, f1, storey, 0.2, 'plaster', [door(3, 1.2)]));
  // Upper floor slab with a stairwell hole along the north wall.
  const holeX0 = 15.9;
  const holeX1 = 22;
  const holeZ1 = -12.2;
  const slabY0 = f2 - 0.15;
  add(boxMinMax({ x: x0, y: slabY0, z: holeZ1 }, { x: x1, y: f2, z: z1 }, 'concrete'));
  add(boxMinMax({ x: x0, y: slabY0, z: z0 }, { x: holeX0, y: f2, z: holeZ1 }, 'concrete'));
  add(boxMinMax({ x: holeX1, y: slabY0, z: z0 }, { x: x1, y: f2, z: holeZ1 }, 'concrete'));
  add(...stairs({ x: 16, y: f1, z: -13.05 }, '+x', 6, f2 - f1, 1.6, 'wood'));
  add(
    boxMinMax({ x: holeX0, y: f2, z: holeZ1 }, { x: holeX1, y: f2 + 1, z: holeZ1 + 0.08 }, 'metal'),
  );
  // Upper storey walls
  const up = 3.2;
  add(
    ...wall({ x: x0, z: z0 }, { x: x0, z: z1 }, f2, up, t, 'plaster', [
      win(2),
      door(6.5, 2),
      win(11.5),
    ]),
  );
  add(...wall({ x: x1, z: z0 }, { x: x1, z: z1 }, f2, up, t, 'plaster', [win(4), win(10)]));
  add(...wall({ x: x0, z: z0 }, { x: x1, z: z0 }, f2, up, t, 'plaster', [win(3), win(9)]));
  add(...wall({ x: x0, z: z1 }, { x: x1, z: z1 }, f2, up, t, 'plaster', [win(3), win(9)]));
  // Roof + parapet (not reachable in M1)
  const roof = f2 + up;
  add(boxMinMax({ x: x0, y: roof, z: z0 }, { x: x1, y: roof + 0.15, z: z1 }, 'concrete'));
  add(...wall({ x: x0, z: z0 }, { x: x1, z: z0 }, roof, 1, t, 'trim'));
  add(...wall({ x: x0, z: z1 }, { x: x1, z: z1 }, roof, 1, t, 'trim'));
  add(...wall({ x: x0, z: z0 }, { x: x0, z: z1 }, roof, 1, t, 'trim'));
  add(...wall({ x: x1, z: z0 }, { x: x1, z: z1 }, roof, 1, t, 'trim'));
  // Street balcony off the upper floor
  add(boxMinMax({ x: 10.5, y: slabY0, z: -8.5 }, { x: x0, y: f2, z: -4 }, 'concrete'));
  add(boxMinMax({ x: 10.5, y: f2, z: -8.5 }, { x: 10.6, y: f2 + 1, z: -4 }, 'metal'));
  add(boxMinMax({ x: 10.5, y: f2, z: -8.5 }, { x: x0, y: f2 + 1, z: -8.4 }, 'metal'));
  add(boxMinMax({ x: 10.5, y: f2, z: -4.1 }, { x: x0, y: f2 + 1, z: -4 }, 'metal'));

  // --- Firing range cover ------------------------------------------------------------------
  add(boxMinMax({ x: -8, y: 0, z: -30.2 }, { x: -4, y: 1.0, z: -29.8 }, 'concrete'));
  add(block(4, -35, 0, 3, 0.9, 0.6, 'concrete'));

  return {
    name: 'test-street',
    bounds: { minX: -40, maxX: 40, minZ: -60, maxZ: 60 },
    boxes,
    sparringSpot: { x: 0, y: 0, z: 30 }, // open street, clear of the low-wall test section
    spawns: [
      { pos: { x: 0, y: 0, z: 45 }, yaw: 0 },
      { pos: { x: -5, y: 0, z: 50 }, yaw: 0 },
      { pos: { x: 18, y: f1, z: -8 }, yaw: Math.PI / 2 },
    ],
    dummies: [
      { id: 'd-near', pos: { x: 0, y: 0, z: -10 }, yaw: Math.PI },
      { id: 'd-mid', pos: { x: -4, y: 0, z: -25 }, yaw: Math.PI },
      { id: 'd-far', pos: { x: 3, y: 0, z: -45 }, yaw: Math.PI },
      {
        id: 'd-strafe',
        pos: { x: -6, y: 0, z: -18 },
        yaw: Math.PI,
        path: { to: { x: 6, y: 0, z: -18 }, speed: 3 },
      },
      { id: 'd-cover', pos: { x: -6, y: 0, z: -31 }, yaw: Math.PI, crouched: true },
      { id: 'd-window', pos: { x: 15, y: f2, z: -1.5 }, yaw: Math.PI / 2 },
    ],
  };
}

export const TEST_STREET: MapDefinition = build();
