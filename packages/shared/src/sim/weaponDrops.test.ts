import { describe, expect, it } from 'vitest';
import { PRIMARIES, PRIMARY_IDS, WEAPON_DROP } from '../config/tunables.ts';
import { createPlayerState } from './player.ts';
import { launchDrone } from './drone.ts';
import {
  clearDropOwner,
  createWeaponDrops,
  nearestDrop,
  observeDropOwners,
  primaryAmmoFraction,
  spawnDeathDrop,
  spawnDrop,
  stepDrops,
  swapWithDrop,
  type WeaponDropCollector,
} from './weaponDrops.ts';

const origin = { x: 0, y: 0, z: 0 };
const collector = (): WeaponDropCollector<string> => ({
  id: 'human',
  player: createPlayerState({ ...origin }),
});

describe('weapon drops', () => {
  it('drops only the remaining primary ammo at the death spot, snapped to the ground', () => {
    const state = createWeaponDrops();
    const player = createPlayerState({ x: 3, y: 6, z: 4 }, 1, 'standard', 'coil');
    player.health = 0;
    player.arsenal.slot = 'sidearm';
    player.guns.rifle.ammo = 2;
    player.guns.rifle.reserve = 13;
    expect(spawnDeathDrop(state, player, 2)).toEqual([{ type: 'spawn', drop: state.drops[0] }]);
    expect(state.drops[0]).toMatchObject({
      primary: 'coil',
      pos: { x: 3, y: 2, z: 4 },
      ammoFraction: 0.5,
      ttl: 30,
    });
    expect(state.drops[0]).not.toHaveProperty('droppedBy');
    player.move.pos.x = 7;
    expect(state.drops[0]!.pos.x).toBe(3);
  });

  it('does not drop empty guns or guns in knife mode', () => {
    const state = createWeaponDrops();
    const player = createPlayerState(origin);
    player.health = 0;
    player.guns.rifle.ammo = player.guns.rifle.reserve = 0;
    expect(spawnDeathDrop(state, player)).toEqual([]);
    player.guns.rifle.ammo = 10;
    player.arsenal.mode = 'knife';
    expect(spawnDeathDrop(state, player)).toEqual([]);
    expect(state.drops).toEqual([]);
  });

  it('despawns at 30 seconds, before anyone can collect on the expiration tick', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'ar7', origin, 0.5);
    const id = state.drops[0]!.id;
    expect(stepDrops(state, [], 29.9)).toEqual([]);
    expect(state.drops).toHaveLength(1);
    const c = collector();
    c.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [c], 0.11)).toEqual([{ type: 'despawn', dropId: id }]);
    expect(c.player.guns.rifle.reserve).toBe(0);
    expect(state.drops).toEqual([]);
  });

  it('caps live drops by removing the oldest and never reuses an id', () => {
    const state = createWeaponDrops();
    for (let i = 0; i < WEAPON_DROP.cap; i++) spawnDrop(state, 'ar7', origin, 1);
    const oldest = state.drops[0]!.id;
    const second = state.drops[1]!.id;
    const events = spawnDrop(state, 'coil', origin, 1);
    expect(events[0]).toEqual({ type: 'despawn', dropId: oldest });
    expect(state.drops).toHaveLength(WEAPON_DROP.cap);
    expect(state.drops[0]!.id).toBe(second);
    expect(new Set(state.drops.map((d) => d.id)).size).toBe(WEAPON_DROP.cap);
    expect(state.drops.at(-1)!.id).not.toBe(oldest);
  });

  it('transfers the same fraction of the receiving gun full load, into reserve only', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    c.player.guns.rifle.ammo = 11;
    c.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [c], 0)).toEqual([
      { type: 'ammo', dropId: state.drops[0]!.id, by: c.id, amount: 75 },
    ]);
    expect(c.player.guns.rifle.ammo).toBe(11);
    expect(c.player.guns.rifle.reserve).toBe(75);
    expect(state.drops[0]!.ammoFraction).toBe(0);
    expect(state.drops).toHaveLength(1);
  });

  it('caps reserve and subtracts only the fraction actually taken', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'shotgun', origin, 0.5);
    const c = collector();
    c.player.guns.rifle.reserve = 100;
    expect(stepDrops(state, [c], 0)[0]).toMatchObject({ type: 'ammo', amount: 20 });
    expect(c.player.guns.rifle.reserve).toBe(120);
    expect(state.drops[0]!.ammoFraction).toBeCloseTo(0.5 - 20 / 150);
  });

  it('preserves sub-round fractions for later guns without generating fractional ammunition', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'ar7', origin, 0.01);
    const c = collector();
    c.player.guns.rifle.reserve = 0;
    stepDrops(state, [c], 0);
    expect(c.player.guns.rifle.reserve).toBe(1);
    expect(state.drops[0]!.ammoFraction).toBeCloseTo(0.01 - 1 / 150);
    expect(stepDrops(state, [c], 0)).toEqual([]);
  });

  it('full players leave the ammo for later collectors', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const full = collector();
    const next = { ...collector(), id: 'next' };
    next.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [full], 0)).toEqual([]);
    expect(state.drops[0]!.ammoFraction).toBe(0.5);
    expect(stepDrops(state, [full, next], 0)[0]).toMatchObject({ by: 'next', amount: 75 });
  });

  it('automatically swaps a completely empty primary for the nearest gun with ammo', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'shotgun', origin, 1);
    state.drops[0]!.ammoFraction = 0;
    spawnDrop(state, 'coil', { x: 0.4, y: 0, z: 0 }, 0.5);
    const c = collector();
    c.player.guns.rifle.ammo = c.player.guns.rifle.reserve = 0;
    const events = stepDrops(state, [c], 0);
    expect(events.some((e) => e.type === 'swap' && e.primary === 'coil')).toBe(true);
    expect(c.player.arsenal.primary).toBe('coil');
    expect(c.player.guns.rifle).toMatchObject({ ammo: 5, reserve: 10 });
    expect(state.drops).toHaveLength(1);
    expect(state.drops[0]!.primary).toBe('shotgun');
  });

  it.each([
    { ammo: 1, reserve: 0 },
    { ammo: 0, reserve: 1 },
  ])('does not automatically swap while the primary still has $ammo + $reserve rounds', (ammo) => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    const c = collector();
    Object.assign(c.player.guns.rifle, ammo);
    expect(stepDrops(state, [c], 0).some((e) => e.type === 'swap')).toBe(false);
    expect(c.player.arsenal.primary).toBe('ar7');
  });

  it('never auto-swaps onto an empty gun, or one whose fraction cannot fill one of its rounds', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.001);
    const c = collector();
    c.player.guns.rifle.ammo = c.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [c], 0)).toEqual([]);
    state.drops[0]!.ammoFraction = 0;
    expect(stepDrops(state, [c], 0)).toEqual([]);
  });

  it.each(['dead', 'bot', 'knife'] as const)(
    'does not let a %s collector take ammo or swap',
    (kind) => {
      const state = createWeaponDrops();
      spawnDrop(state, 'coil', origin, 1);
      const c = { ...collector(), bot: kind === 'bot' };
      if (kind === 'dead') c.player.health = 0;
      if (kind === 'knife') c.player.arsenal.mode = 'knife';
      c.player.guns.rifle.ammo = c.player.guns.rifle.reserve = 0;
      expect(stepDrops(state, [c], 0)).toEqual([]);
      expect(swapWithDrop(state, c)).toEqual([]);
      expect(state.drops[0]!.ammoFraction).toBe(1);
    },
  );

  it('E swaps the nearest gun, fills its mag first, drops the previous gun at the feet and draws', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'shotgun', { x: 1.4, y: 0, z: 0 }, 1);
    spawnDrop(state, 'coil', { x: 1.2, y: 0, z: 0 }, 0.5);
    const c = collector();
    c.groundY = -0.1;
    c.player.guns.rifle.ammo = 12;
    c.player.guns.rifle.reserve = 18;
    c.player.guns.rifle.shotCounter = 41;
    const events = swapWithDrop(state, c);
    expect(events.some((e) => e.type === 'swap' && e.primary === 'coil')).toBe(true);
    expect(c.player.arsenal).toMatchObject({
      primary: 'coil',
      target: 'rifle',
      switchTimer: PRIMARIES.coil.equipTime,
      switchDuration: PRIMARIES.coil.equipTime,
    });
    expect(c.player.guns.rifle).toMatchObject({ ammo: 5, reserve: 10, shotCounter: 41 });
    expect(state.drops.at(-1)).toMatchObject({
      primary: 'ar7',
      pos: { x: 0, y: -0.1, z: 0 },
      ammoFraction: 0.2,
      ttl: 30,
    });
  });

  it('E can take a drained gun, and discards an empty current gun', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    state.drops[0]!.ammoFraction = 0;
    const c = collector();
    c.player.guns.rifle.ammo = c.player.guns.rifle.reserve = 0;
    expect(swapWithDrop(state, c).some((e) => e.type === 'swap')).toBe(true);
    expect(c.player.guns.rifle).toMatchObject({ ammo: 0, reserve: 0 });
    expect(state.drops).toEqual([]);
  });

  it('does not bounce back to the loaded old gun after E takes a drained gun', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    state.drops[0]!.ammoFraction = 0;
    const c = collector();
    swapWithDrop(state, c);
    expect(c.player.arsenal.primary).toBe('coil');
    expect(c.player.guns.rifle).toMatchObject({ ammo: 0, reserve: 0 });
    expect(state.drops[0]).toMatchObject({ primary: 'ar7', ammoFraction: 1 });

    // The E tick omits its collector; later ticks must keep respecting the owner lock.
    stepDrops(state, [], 1 / 60);
    for (let i = 0; i < 5; i++) expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(c.player.arsenal.primary).toBe('coil');
    expect(c.player.guns.rifle).toMatchObject({ ammo: 0, reserve: 0 });
    expect(state.drops[0]).toMatchObject({ primary: 'ar7', ammoFraction: 1 });

    c.player.move.pos = { ...origin, x: WEAPON_DROP.pickupRadius + 0.1 };
    stepDrops(state, [c], 1 / 60);
    c.player.move.pos = { ...origin };
    expect(stepDrops(state, [c], 1 / 60).some((e) => e.type === 'swap')).toBe(true);
    expect(c.player.arsenal.primary).toBe('ar7');
    expect(c.player.guns.rifle).toMatchObject({ ammo: 30, reserve: 120 });
    expect(state.drops).toEqual([]);
  });

  it('keeps the discarded ammo intact until the owner leaves the pickup radius and returns', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    swapWithDrop(state, c);
    expect(state.drops[0]).toMatchObject({ droppedBy: c.id, ownerClear: false, ammoFraction: 1 });
    for (let i = 0; i < 5; i++) expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(c.player.guns.rifle).toMatchObject({ ammo: 5, reserve: 10 });
    expect(state.drops[0]!.ammoFraction).toBe(1);
    c.player.move.pos = { ...origin, x: WEAPON_DROP.pickupRadius };
    expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(state.drops[0]!.ownerClear).toBe(false);
    c.player.move.pos.x += 0.1;
    expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(state.drops[0]!.ownerClear).toBe(true);
    c.player.move.pos = { ...origin };
    expect(stepDrops(state, [c], 1 / 60)).toContainEqual({
      type: 'ammo',
      dropId: state.drops[0]!.id,
      by: c.id,
      amount: 15,
    });
    expect(state.drops[0]!.ammoFraction).toBe(0.5);
  });

  it('observes each owner position without collecting ammo or advancing drop time', () => {
    const state = createWeaponDrops();
    const c = collector();
    spawnDrop(state, 'coil', origin, 0.5, 0, 'standard', c.id);
    const drop = state.drops[0]!;
    c.player.guns.rifle.reserve = 0;
    const original = { ...drop, pos: { ...drop.pos } };

    c.player.move.pos = { ...origin, x: WEAPON_DROP.pickupRadius };
    observeDropOwners(state, [c]);
    expect(drop).toEqual(original);

    c.player.move.pos.x += 0.01;
    observeDropOwners(state, [{ ...c, skipAuto: true }]);
    c.player.move.pos = { ...origin };
    observeDropOwners(state, [c]);
    expect(drop).toEqual({ ...original, ownerClear: true });
    expect(c.player.guns.rifle.reserve).toBe(0);
    expect(state.drops).toHaveLength(1);

    expect(stepDrops(state, [c], 1 / 60)).toContainEqual({
      type: 'ammo',
      dropId: drop.id,
      by: c.id,
      amount: 75,
    });
  });

  it('observes only supplied owners and leaves unowned drops unchanged', () => {
    const state = createWeaponDrops();
    const c = collector();
    spawnDrop(state, 'coil', origin, 0.5, 0, 'standard', c.id);
    spawnDrop(state, 'ar7', origin, 1);
    const before = { ...state, drops: state.drops.map((drop) => ({ ...drop })) };
    const other = { ...collector(), id: 'other' };
    other.player.move.pos.x = WEAPON_DROP.pickupRadius + 1;
    observeDropOwners(state, []);
    observeDropOwners(state, [other]);
    expect(state).toEqual(before);
  });

  it('observes owner death and vertical clearance without automatic collection', () => {
    for (const reason of ['death', 'height']) {
      const state = createWeaponDrops();
      const c = collector();
      spawnDrop(state, 'coil', origin, 0.5, 0, 'standard', c.id);
      const original = { ...state.drops[0]! };
      if (reason === 'death') c.player.health = 0;
      else c.player.move.pos.y = WEAPON_DROP.pickupHeight + 0.01;
      observeDropOwners(state, [c]);
      expect(state.drops).toEqual([{ ...original, ownerClear: true }]);
    }
  });

  it('lets another player take ammo immediately while the owner remains nearby', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    swapWithDrop(state, c);
    const other = { ...collector(), id: 'other' };
    other.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [c, other], 1 / 60)).toEqual([
      { type: 'ammo', dropId: state.drops[0]!.id, by: other.id, amount: 120 },
    ]);
    expect(c.player.guns.rifle.reserve).toBe(10);
    expect(state.drops[0]!.ownerClear).toBe(false);
  });

  it('observes leaving the radius even on a tick that skips automatic collection', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    swapWithDrop(state, c);
    c.player.move.pos = { ...origin, x: WEAPON_DROP.pickupRadius + 0.1 };
    expect(stepDrops(state, [{ ...c, skipAuto: true }], 1 / 60)).toEqual([]);
    expect(state.drops[0]!.ownerClear).toBe(true);
    c.player.move.pos = { ...origin };
    expect(stepDrops(state, [c], 1 / 60)).toContainEqual(
      expect.objectContaining({ type: 'ammo', by: c.id }),
    );
  });

  it('can auto-swap to another loaded drop while its nearest own drop stays locked', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    state.drops[0]!.ammoFraction = 0;
    const c = collector();
    swapWithDrop(state, c);
    spawnDrop(state, 'shotgun', { ...origin, x: 0.5 }, 0.5);
    expect(stepDrops(state, [c], 1 / 60)).toContainEqual(
      expect.objectContaining({ type: 'swap', by: c.id, primary: 'shotgun' }),
    );
    expect(state.drops[0]).toMatchObject({ primary: 'ar7', ammoFraction: 1, ownerClear: false });
    expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(state.drops[0]!.ammoFraction).toBe(1);
  });

  it('allows a deliberate E swap back without leaving the pickup radius', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    swapWithDrop(state, c);
    expect(nearestDrop(state.drops, c.player.move.pos)).toBe(state.drops[0]);
    expect(swapWithDrop(state, c)).toContainEqual(
      expect.objectContaining({ type: 'swap', primary: 'ar7' }),
    );
    expect(c.player.guns.rifle).toMatchObject({ ammo: 30, reserve: 120 });
  });

  it.each(['death', 'respawn'] as const)('releases the owner lock on %s', (reason) => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    swapWithDrop(state, c);
    if (reason === 'death') {
      c.player.health = 0;
      expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    } else clearDropOwner(state.drops, c.id);
    expect(state.drops[0]!.ownerClear).toBe(true);
    c.player = createPlayerState(origin);
    c.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [c], 1 / 60)).toContainEqual(
      expect.objectContaining({ type: 'ammo', by: c.id, amount: 120 }),
    );
  });

  it('keeps an E-taken drained gun when the old gun was empty until a loaded drop is reached', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    state.drops[0]!.ammoFraction = 0;
    const c = collector();
    c.player.guns.rifle.ammo = c.player.guns.rifle.reserve = 0;
    swapWithDrop(state, c);
    expect(state.drops).toEqual([]);
    expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(c.player.arsenal.primary).toBe('coil');

    spawnDrop(state, 'shotgun', { x: 3, y: 0, z: 0 }, 1);
    expect(stepDrops(state, [c], 1 / 60)).toEqual([]);
    expect(c.player.arsenal.primary).toBe('coil');
    c.player.move.pos.x = 3;
    expect(stepDrops(state, [c], 1 / 60).some((e) => e.type === 'swap')).toBe(true);
    expect(c.player.arsenal.primary).toBe('shotgun');
    expect(c.player.guns.rifle).toMatchObject({ ammo: 7, reserve: 28 });
    expect(state.drops).toEqual([]);
  });

  it('gives the truck E priority and uses the same nearest-drop decision for the HUD', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    const c = collector();
    expect(nearestDrop(state.drops, origin)).toBe(state.drops[0]);
    expect(nearestDrop(state.drops, origin, true)).toBeNull();
    expect(swapWithDrop(state, c, true)).toEqual([]);
    expect(c.player.arsenal.primary).toBe('ar7');
  });

  it('does not take a gun from a truck seat or while piloting the drone', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 1);
    const c = collector();
    c.player.guns.rifle.reserve = 0;
    c.player.seat = { vehicle: 1, seat: 'driver' };
    expect(stepDrops(state, [c], 0)).toEqual([]);
    expect(swapWithDrop(state, c)).toEqual([]);
    c.player.seat = null;
    c.player.drone = launchDrone(1, origin, 0);
    expect(swapWithDrop(state, c)).toEqual([]);
    expect(c.player.arsenal.primary).toBe('ar7');
  });

  it('holsters the sidearm and clears the taken primary transient state before raising it', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    c.player.arsenal.slot = c.player.arsenal.target = 'sidearm';
    c.player.guns.sidearm.reloadTimer = 0.5;
    c.player.guns.sidearm.adsAmount = 1;
    c.player.guns.rifle.heat = 1;
    c.player.guns.rifle.charge = 0.5;
    swapWithDrop(state, c);
    expect(c.player.guns.sidearm).toMatchObject({ reloadTimer: 0, adsAmount: 0 });
    expect(c.player.guns.rifle).toMatchObject({ heat: 0, charge: 0, reloadTimer: 0 });
  });

  it('requires the same floor and the appropriate walking or E radius', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', { x: WEAPON_DROP.pickupRadius + 0.1, y: 0, z: 0 }, 1);
    const c = collector();
    c.player.guns.rifle.reserve = 0;
    expect(stepDrops(state, [c], 0)).toEqual([]);
    expect(nearestDrop(state.drops, origin)).toBe(state.drops[0]);
    expect(nearestDrop(state.drops, { x: -2, y: 0, z: 0 })).toBeNull();
    c.player.move.pos.y = 4;
    expect(stepDrops(state, [c], 0)).toEqual([]);
    expect(swapWithDrop(state, c)).toEqual([]);
  });

  it.each(PRIMARY_IDS)(
    'round-trips every integer ammo load of %s without losing a round',
    (primary) => {
      const cfg = PRIMARIES[primary];
      const fullLoad = cfg.magazineSize + cfg.reserveAmmo;
      for (let total = 1; total <= fullLoad; total++) {
        const state = createWeaponDrops();
        const c = collector();
        const fraction = primaryAmmoFraction(primary, {
          ammo: Math.min(total, cfg.magazineSize),
          reserve: Math.max(0, total - cfg.magazineSize),
        });
        spawnDrop(state, primary, origin, fraction);
        swapWithDrop(state, c);
        expect(c.player.guns.rifle.ammo + c.player.guns.rifle.reserve).toBe(total);
      }
    },
  );

  it('respawning creates the chosen loadout with fresh ammo, rather than the picked-up gun', () => {
    const state = createWeaponDrops();
    spawnDrop(state, 'coil', origin, 0.5);
    const c = collector();
    swapWithDrop(state, c);
    const respawn = createPlayerState(origin, c.player.seed, 'standard', 'ar7');
    expect(respawn.arsenal.primary).toBe('ar7');
    expect(respawn.guns.rifle).toMatchObject({ ammo: 30, reserve: 120 });
  });
});
