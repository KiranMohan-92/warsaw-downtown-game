import { beforeAll, describe, expect, it } from 'vitest';
import { PLAYER } from '../config/tunables.ts';
import { Button } from '../sim/input.ts';
import { createPlayerState } from '../sim/player.ts';
import { run } from '../sim/testUtils.ts';
import { initPhysics, PhysicsWorld } from '../physics/world.ts';
import { APRON, DECOR, decorToWorld, LAMP_CLEARANCE, scatterDecor } from './decor.ts';
import { MARKET_BOUNDS } from './placDefilad/market.ts';
import { placDefilad } from './placDefilad/index.ts';
import { crate, cratePile, crateSteps, jersey, sandbags } from './props.ts';
import { resolveMap } from './registry.ts';
import { TEST_STREET } from './testStreet.ts';
import type { MapBox, MapDefinition } from './types.ts';

/** The Market (built once: the full map takes a second or two). */
let market: MapDefinition;
beforeAll(async () => {
  await initPhysics();
  market = resolveMap(placDefilad(), 'market');
}, 120_000);

describe('prop model tags', () => {
  it('crate, crate pile, crate steps and jersey builders tag every part; others stay untagged', () => {
    const at = { x: 3, z: 4, rot: 30 };
    for (const b of [...crate(at), ...cratePile(at), ...crateSteps(at)])
      expect(b.model).toBe('crate');
    for (const b of jersey(at, 6)) expect(b.model).toBe('jersey');
    for (const b of sandbags(at)) expect(b.model).toBeUndefined();
  });

  it('tagged crates retain their placement envelope', () => {
    const [b] = crate({ x: 1, z: 2 }, 1.1);
    const { model, ...plain } = b!;
    expect(model).toBe('crate');
    expect(plain.size).toEqual({ x: 1.1, y: 1.1, z: 1.1 });
    expect(plain.center).toEqual({ x: 1, y: 0.55, z: 2 });
  });

  it('the Market and the range carry tagged crates and jersey barriers', () => {
    const inMarket = (b: MapBox): boolean =>
      b.center.x > MARKET_BOUNDS.minX &&
      b.center.x < MARKET_BOUNDS.maxX &&
      b.center.z > MARKET_BOUNDS.minZ &&
      b.center.z < MARKET_BOUNDS.maxZ;
    const tagged = market.boxes.filter((b) => b.model && inMarket(b));
    expect(tagged.filter((b) => b.model === 'crate').length).toBeGreaterThan(20);
    expect(tagged.filter((b) => b.model === 'jersey').length).toBeGreaterThan(1);
    const range = TEST_STREET;
    expect(range.boxes.filter((b) => b.model === 'crate').length).toBeGreaterThan(0);
    expect(range.boxes.filter((b) => b.model === 'jersey').length).toBe(2);
    expect(market.boxes.filter((b) => b.model).every(inMarket)).toBe(true);
  });
});

describe('solid crate movement', () => {
  const floor: MapBox = {
    center: { x: 0, y: -0.5, z: 0 },
    size: { x: 30, y: 1, z: 30 },
    mat: 'ground',
  };
  const worldOf = (boxes: MapBox[]): PhysicsWorld =>
    new PhysicsWorld({
      name: 'solid-props',
      bounds: { minX: -15, maxX: 15, minZ: -15, maxZ: 15 },
      boxes: [floor, ...boxes],
      spawns: [],
      dummies: [],
    });

  it('rejects standing and crouched capsules entirely inside a tall crate', () => {
    const boxes = crate({ x: 0, z: 0 }, 1.2).map((b) => ({
      ...b,
      center: { ...b.center, y: 1.1 },
      size: { ...b.size, y: 2.2 },
    }));
    const physics = worldOf(boxes);
    try {
      expect(physics.overlapsStatic({ x: 0, y: 0.02, z: 0 }, PLAYER.standHeight)).toBe(true);
      expect(physics.overlapsStatic({ x: 0, y: 0.2, z: 0 }, PLAYER.crouchHeight)).toBe(true);
    } finally {
      physics.free();
    }
  });

  it('blocks walking into cover and supports a jump onto the scanned lid', () => {
    const physics = worldOf(crate({ x: 0, z: -2 }));
    const feet = { x: 0, y: 0.02, z: 0 };
    const body = physics.createCharacter(feet);
    const player = createPlayerState(feet);
    try {
      run(player, body, 0.3, {});
      run(player, body, 1, { moveZ: 1 });
      expect(player.move.pos.z).toBeGreaterThan(-1.4);
      run(player, body, 0.3, (i) => ({ moveZ: 1, buttons: i === 0 ? Button.Jump : 0 }));
      run(player, body, 0.7, {});
      expect(player.move.pos.y).toBeGreaterThan(0.84);
      expect(player.move.grounded).toBe(true);
    } finally {
      physics.free();
    }
  });
});

describe('scatterDecor on the Market', () => {
  let map: MapDefinition;
  let physics: PhysicsWorld;
  beforeAll(() => {
    map = market;
    physics = new PhysicsWorld(map);
  }, 120_000);

  it('places a deterministic mix of dressing inside the Market, lamps included', () => {
    const decor = map.decor ?? [];
    expect(decor.length).toBeGreaterThan(20);
    expect(decor.length).toBeLessThanOrEqual(90);
    const kinds = new Set(decor.map((d) => d.kind));
    for (const k of ['lamp', 'bin', 'trashbag', 'tyres', 'drum'] as const)
      expect(kinds.has(k)).toBe(true);
    for (const d of decor) {
      expect(d.x).toBeGreaterThan(MARKET_BOUNDS.minX);
      expect(d.x).toBeLessThan(MARKET_BOUNDS.maxX);
      expect(d.z).toBeGreaterThan(MARKET_BOUNDS.minZ);
      expect(d.z).toBeLessThan(MARKET_BOUNDS.maxZ);
    }
  });

  it('never narrows a passage: a standing player fits in front of every wall piece', () => {
    for (const d of map.decor ?? []) {
      const def = DECOR[d.kind];
      if (def.place !== 'wall') continue;
      const reach = def.size.z / 2 + PLAYER.radius + 0.05;
      for (const step of [reach, reach + (APRON - 2 * PLAYER.radius) / 2]) {
        const p = decorToWorld(d, 0, step);
        expect(physics.overlapsStatic({ x: p.x, y: 0.02, z: p.z }, PLAYER.standHeight)).toBe(false);
      }
    }
  });

  it('lamps stand in the open: a player fits all round them', () => {
    const lamps = (map.decor ?? []).filter((d) => d.kind === 'lamp');
    expect(lamps.length).toBeGreaterThan(0);
    const ring = LAMP_CLEARANCE - PLAYER.radius - 0.05;
    for (const d of lamps) {
      for (let a = 0; a < 8; a++) {
        const t = (a * Math.PI) / 4;
        const p = { x: d.x + ring * Math.cos(t), y: 0.02, z: d.z + ring * Math.sin(t) };
        expect(physics.overlapsStatic(p, PLAYER.standHeight)).toBe(false);
      }
    }
  });

  it('keeps clear of bushes and of each other', () => {
    const decor = map.decor ?? [];
    for (const d of decor) {
      const reach = Math.hypot(DECOR[d.kind].size.x, DECOR[d.kind].size.z) / 2;
      for (const f of map.foliage ?? [])
        expect(Math.hypot(f.x - d.x, f.z - d.z)).toBeGreaterThan(f.r + reach);
      for (const o of decor) {
        if (o !== d) expect(Math.hypot(o.x - d.x, o.z - d.z)).toBeGreaterThan(0.9);
      }
    }
  });

  it('respects keep-clear rects and the piece limit', () => {
    const input = {
      bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
      boxes: [
        {
          center: { x: 0, y: 1.3, z: 0 },
          size: { x: 6, y: 2.6, z: 2.4 },
          mat: 'container' as const,
        },
        {
          center: { x: 10, y: 1.3, z: 0 },
          size: { x: 6, y: 2.6, z: 2.4 },
          mat: 'container' as const,
        },
      ],
      prisms: [],
      trees: [],
      foliage: [],
      keepClear: [],
      density: 1,
    };
    const all = scatterDecor(input);
    expect(all.length).toBeGreaterThan(2);
    expect(scatterDecor(input)).toEqual(all);
    expect(scatterDecor({ ...input, max: 2 })).toHaveLength(2);
    const walled = scatterDecor({ ...input, keepClear: [{ x0: -20, z0: -20, x1: 20, z1: 20 }] });
    expect(walled).toEqual([]);
  });
});
