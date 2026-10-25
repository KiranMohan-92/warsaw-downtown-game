import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../../config/tunables.ts';
import { initPhysics, PhysicsWorld } from '../../physics/world.ts';
import { createPlayerState, stepPlayer } from '../../sim/player.ts';
import { resolveMap } from '../registry.ts';
import { DEFILAD_CUT_Z, placDefilad } from './index.ts';
import { MARKET_BOUNDS, TRUCK_LANES } from './market.ts';
import {
  buildDriveGraph,
  driveComponents,
  driveRoute,
  nearestDriveNode,
  smoothDriveRoute,
} from '../../sim/vehicles/driveGraph.ts';
import { bodyOverlaps } from '../../sim/vehicles/vehicle.ts';

/**
 * Walk the real player sim (stepPlayer + Rapier character, same code as client/server/bots)
 * through the map's key routes: stairs, ramps, scaffold stair towers, section cuts.
 */
type Wp = [number, number]; // x, z

let full: PhysicsWorld;
let south: PhysicsWorld;
let market: PhysicsWorld;
beforeAll(async () => {
  await initPhysics();
  full = new PhysicsWorld(placDefilad());
  south = new PhysicsWorld(resolveMap(placDefilad(), 'south'));
  market = new PhysicsWorld(resolveMap(placDefilad(), 'market'));
}, 60_000);

/** Walk waypoint to waypoint (sprinting off), returning the final feet position. */
function walk(
  world: PhysicsWorld,
  start: { x: number; y: number; z: number },
  wps: Wp[],
  maxSeconds = 40,
) {
  const body = world.createCharacter(start);
  const p = createPlayerState(start);
  let seq = 0;
  let i = 0;
  let stuck = 0;
  let last = { ...start };
  for (let t = 0; t < maxSeconds && i < wps.length; t += SIM_DT) {
    const [tx, tz] = wps[i]!;
    const m = p.move.pos;
    const dx = tx - m.x;
    const dz = tz - m.z;
    if (Math.hypot(dx, dz) < 0.35) {
      i++;
      continue;
    }
    const yaw = Math.atan2(-dx, -dz);
    stepPlayer(p, { seq: seq++, moveX: 0, moveZ: 1, yaw, pitch: 0, buttons: 0 }, SIM_DT, body);
    // Stuck detection: no progress for 2 s.
    if (Math.hypot(m.x - last.x, m.z - last.z) < 0.001) stuck += SIM_DT;
    else stuck = 0;
    last = { ...m };
    if (stuck > 2) break;
  }
  return { pos: { ...p.move.pos }, reached: i, of: wps.length };
}

describe('Plac Defilad routes (walked with the real player sim)', () => {
  it('underpass: up the north stair from the tunnel to the plaza', () => {
    const r = walk(full, { x: 231, y: -4.95, z: 80 }, [
      [231, 72],
      [231, 58],
    ]);
    expect(r.reached).toBe(r.of);
    expect(r.pos.y).toBeGreaterThan(-0.1);
  });

  it('car park: up the vehicle ramp to the street', () => {
    const r = walk(full, { x: 191, y: -4.95, z: 140 }, [
      [191, 150],
      [191, 172],
    ]);
    expect(r.reached).toBe(r.of);
    expect(r.pos.y).toBeGreaterThan(-0.1);
  });

  it('service tunnel: up the stair into the Palace north-east hall', () => {
    const r = walk(full, { x: 78, y: -4.95, z: -135 }, [
      [78, -122],
      [78, -108],
      [70, -100],
    ]);
    expect(r.reached).toBe(r.of);
    expect(r.pos.y).toBeGreaterThan(-0.1);
    expect(r.pos.y).toBeLessThan(0.5); // inside the hall, not on the roof
  });

  it('construction site: scaffold stair tower up to the skeleton first floor', () => {
    // rot 180 at (170, -158.75): deck x 160..180, tower towards −X; lane A z −158.15, B −159.35.
    const r = walk(full, { x: 161, y: 0.02, z: -158.15 }, [
      [156.4, -158.15], // flight A → landing (2 m)
      [156.4, -159.35],
      [160.8, -159.35], // flight B → deck (4 m)
      [171, -159],
      [171, -164], // onto the skeleton slab (between columns)
    ]);
    expect(r.reached).toBe(r.of);
    expect(r.pos.y).toBeGreaterThan(3.9);
  });

  it('Palace: renovation scaffold up to the 16 m wing roof', () => {
    // NE scaffold: rot 270 at (85.35, -96): deck along z, tower towards +z (lanes at x ± 0.6).
    const wps: Wp[] = [];
    for (let k = 0; k < 4; k++) {
      wps.push([85.95, -88.3], [85.95, -84.9], [84.75, -84.9], [84.75, -88.8]);
      if (k < 3) wps.push([85.95, -88.6]);
    }
    wps.push([85.3, -95], [80, -95]); // off the top deck onto the roof
    const r = walk(full, { x: 85.95, y: 0.02, z: -90 }, wps, 80);
    expect(r.pos.y).toBeGreaterThan(15.5);
    expect(r.reached).toBe(r.of);
  });

  it('service tunnel: out to the north square and out to the park', () => {
    const square = walk(full, { x: 30, y: -4.95, z: -143 }, [
      [4, -143],
      [4, -130],
      [4, -116],
    ]);
    expect(square.reached).toBe(square.of);
    expect(square.pos.y).toBeGreaterThan(-0.1);
    const park = walk(full, { x: 59, y: -4.95, z: -160 }, [
      [59, -200],
      [59, -217],
    ]);
    expect(park.reached).toBe(park.of);
    expect(park.pos.y).toBeGreaterThan(-0.1);
  });

  it('Palace courtyards: each reachable by two separate passages', () => {
    for (const [cz, sq] of [
      [-53, -88], // north courtyard: west passage in, out to the north square
      [51, 88], // south courtyard: west passage in, out to the south square
    ] as const) {
      const r = walk(full, { x: -94, y: 0.02, z: cz }, [
        [-80, cz],
        [-50, cz],
        [-43, cz < 0 ? -60 : 60],
        [-43, sq],
      ]);
      expect(r.reached, `courtyard at z ${cz}`).toBe(r.of);
    }
  });

  it('Palace: south-east renovation scaffold up to the roof', () => {
    // rot 270 at (87.3, 92): lanes A x 87.9, B x 86.7; tower towards +Z from z 99.5.
    const wps: Wp[] = [];
    for (let k = 0; k < 4; k++) {
      wps.push([87.9, 99.7], [87.9, 103.1], [86.7, 103.1], [86.7, 99.2]);
      if (k < 3) wps.push([87.9, 99.4]);
    }
    wps.push([87.3, 92], [82, 92]);
    const r = walk(full, { x: 87.9, y: 0.02, z: 98 }, wps, 80);
    expect(r.pos.y).toBeGreaterThan(15.5);
    expect(r.reached).toBe(r.of);
  });

  it('Market metro: from the ticket hall out through all four entrances', () => {
    // Leave the hall along z = 2.2 (clear of the counter island on the centre line).
    const routes: [string, Wp[]][] = [
      [
        'west (forecourt)',
        [
          [95, 2.2],
          [95, 0],
          [60, 0],
        ],
      ],
      [
        'north branch',
        [
          [120, 2.2],
          [120, -20],
          [120, -47],
        ],
      ],
      [
        'south branch',
        [
          [148, 2.2],
          [148, 20],
          [148, 47],
        ],
      ],
      [
        'east',
        [
          [150, 2.2],
          [150, 0],
          [168, 0],
        ],
      ],
    ];
    for (const [name, wps] of routes) {
      const r = walk(market, { x: 101, y: -4.95, z: 7 }, [[101, 7], [101, 2.2], ...wps]);
      expect(r.reached, name).toBe(r.of);
      expect(r.pos.y, name).toBeGreaterThan(-0.1);
    }
  });

  it('Market size: the container wall seals the east edge', () => {
    const r = walk(market, { x: 168.5, y: 0.02, z: -10.5 }, [[200, -10.5]], 6);
    expect(r.pos.x).toBeLessThan(MARKET_BOUNDS.maxX);
  });

  it('the Złota cut wall exists in the halves and not in the full block', () => {
    // A ray along open ground above the props, crossing the cut: blocked only in a half.
    const from = { x: 150, y: 8, z: DEFILAD_CUT_Z + 20 };
    const dir = { x: 0, y: 0, z: -1 };
    expect(south.castRay(from, dir, 40)?.distance).toBeCloseTo(20 - 0.3, 0);
    const open = full.castRay(from, dir, 40);
    expect(open === null || open.distance > 21).toBe(true);
  });
});

describe('truck lanes (Kiran: clear drivable routes through the forecourt and the west edge)', () => {
  it('every lane is clear for the truck down its whole length, and the trucks park in them', () => {
    const map = resolveMap(placDefilad(), 'market');
    expect(map.truckLanes).toBe(TRUCK_LANES);
    // The long lanes (the bends' turning room is short), driven down the middle at their axis.
    for (const r of TRUCK_LANES.filter((l) => Math.max(l.x1 - l.x0, l.z1 - l.z0) >= 12)) {
      const alongX = r.x1 - r.x0 > r.z1 - r.z0;
      const len = alongX ? r.x1 - r.x0 : r.z1 - r.z0;
      for (let t = 3; t <= len - 3; t += 1) {
        const x = alongX ? r.x0 + t : (r.x0 + r.x1) / 2;
        const z = alongX ? (r.z0 + r.z1) / 2 : r.z0 + t;
        const g = market.castRay({ x, y: 3, z }, { x: 0, y: -1, z: 0 }, 6)!;
        expect(g.point.y, `ground in ${JSON.stringify(r)}`).toBeLessThan(0.3);
        const clear = !bodyOverlaps(
          market,
          { x, y: g.point.y, z },
          alongX ? Math.PI / 2 : 0,
          0,
          0,
          0.2, // the body with 20 cm to spare all round
        );
        expect(clear, `truck fits at (${x}, ${z})`).toBe(true);
      }
    }
    const inLane = (p: { x: number; z: number }): boolean =>
      TRUCK_LANES.some((r) => p.x > r.x0 && p.x < r.x1 && p.z > r.z0 && p.z < r.z1);
    for (const v of map.vehicles ?? []) expect(inLane(v)).toBe(true);
  });

  it('the trucks drive from one parking spot to the other down the lanes in a few straight legs', () => {
    const map = resolveMap(placDefilad(), 'market');
    const g = buildDriveGraph(market, map.bounds);
    const [a, b] = (map.vehicles ?? []).map((s) => nearestDriveNode(g, s, 2.5));
    const ids = driveRoute(g, a!, b!)!;
    expect(ids).not.toBeNull();
    const legs = smoothDriveRoute(g, ids);
    // Straight legs, not the 2 m grid's steps.
    expect(legs.length).toBeLessThanOrEqual(16);
    expect(legs.length).toBeLessThan(ids.length / 4);
    // Most of the way is in a lane.
    const inLane = (p: { x: number; z: number }): boolean =>
      TRUCK_LANES.some((r) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1);
    const share = ids.filter((i) => inLane(g.nodes[i]!)).length / ids.length;
    expect(share).toBeGreaterThan(0.8);
  });
});

describe('truck routes (the armored 4x4, 2.1 m wide)', () => {
  it('both trucks stand clear on one drivable network and can reach each other', () => {
    const map = resolveMap(placDefilad(), 'market');
    const g = buildDriveGraph(market, map.bounds);
    const comp = driveComponents(g);
    const spots = map.vehicles ?? [];
    expect(spots).toHaveLength(2);
    const ids = spots.map((s) => {
      const ground = market.castRay({ x: s.x, y: 3, z: s.z }, { x: 0, y: -1, z: 0 }, 6)!;
      expect(bodyOverlaps(market, { x: s.x, y: ground.point.y, z: s.z }, s.yaw, 0, 0)).toBe(false);
      return nearestDriveNode(g, s, 2.5);
    });
    expect(ids.every((i) => i >= 0)).toBe(true);
    expect(comp[ids[0]!]).toBe(comp[ids[1]!]);
    // The network they share (2 m cells, 0.45 m clear each side) is the forecourt and the
    // wider alleys (~840 cells, ~3,400 m²), not a parking pocket.
    const size = [...comp].filter((c) => c === comp[ids[0]!]).length;
    expect(size).toBeGreaterThan(600);
    const route = driveRoute(g, ids[0]!, ids[1]!);
    expect(route).not.toBeNull();
    expect(route!.length).toBeGreaterThan(20);
  });
});
