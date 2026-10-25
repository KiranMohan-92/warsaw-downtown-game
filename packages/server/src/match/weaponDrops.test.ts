import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Button,
  emptyInput,
  PRIMARIES,
  initPhysics,
  MATCH,
  PRIMARY_IDS,
  SIM,
  SIM_DT,
  WEAPON_DROP,
  type PlayerInput,
  type Vec3,
} from '@wd/shared';
import { MatchSim, type ServerPlayer } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});
const matches: MatchSim[] = [];
afterEach(() => {
  for (const sim of matches.splice(0)) sim.dispose();
});

function match(extra: Partial<ConstructorParameters<typeof MatchSim>[0]> = {}): MatchSim {
  const sim = new MatchSim({
    map: 'range',
    size: 'full',
    mode: 'standard',
    spawnProtection: 0,
    vehicles: 'off',
    ...extra,
  });
  matches.push(sim);
  return sim;
}

function place(p: ServerPlayer, pos: Vec3): void {
  p.body.setPosition(pos);
  p.body.setGrounded(true);
  p.state.move.pos = { ...pos };
  p.state.move.vel = { x: 0, y: 0, z: 0 };
}

function feed(sim: MatchSim, p: ServerPlayer, input: Partial<PlayerInput> = {}): void {
  const seq = p.lastSeq + 1;
  sim.receiveInputs(p.id, [{ ...emptyInput(seq), ...input }], sim.nowMs);
  sim.step();
}

/** One real lethal shot down the range's clear firing lane. */
function kill(sim: MatchSim, shooter: ServerPlayer, victim: ServerPlayer): void {
  place(shooter, { x: 0, y: 0, z: -12 });
  place(victim, { x: 0, y: 0, z: -22 });
  victim.state.health = 1;
  const pitch = Math.atan2(1.17 - shooter.state.move.eyeHeight, 10);
  // Settle ADS and seed the target's history after placement.
  for (let i = 0; i < 20; i++) feed(sim, shooter, { pitch, buttons: Button.Ads });
  feed(sim, shooter, { pitch, buttons: Button.Ads | Button.Fire });
  expect(victim.state.health).toBe(0);
}

describe('authoritative weapon drops', () => {
  it('replicates a killed player’s gun, transfers ammo, and corrects an E swap for everyone', () => {
    const sim = match();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'B', 0, false, { primary: 'shotgun' });
    b.state.guns.rifle.ammo = 3;
    b.state.guns.rifle.reserve = 10;
    kill(sim, a, b);
    const dropped = sim.snapshot('a').drops![0]!;
    expect(dropped.primary).toBe('shotgun');
    expect(dropped.pos.x).toBeCloseTo(b.state.move.pos.x, 5);
    expect(dropped.pos.z).toBeCloseTo(b.state.move.pos.z, 5);
    expect(dropped.pos.y).toBeCloseTo(0, 2);
    expect(dropped.ammoFraction).toBeCloseTo(
      13 / (PRIMARIES.shotgun.magazineSize + PRIMARIES.shotgun.reserveAmmo),
    );
    expect(sim.drainDrops()).toContainEqual(expect.objectContaining({ type: 'spawn' }));

    a.state.guns.rifle.reserve = PRIMARIES.ar7.reserveAmmo - 5;
    place(a, dropped.pos);
    feed(sim, a);
    expect(a.state.guns.rifle.reserve).toBe(PRIMARIES.ar7.reserveAmmo);
    expect(sim.drainDrops()).toContainEqual(
      expect.objectContaining({ type: 'ammo', by: 'a', amount: 5 }),
    );
    const oldAmmo = a.state.guns.rifle.ammo + a.state.guns.rifle.reserve;
    feed(sim, a, { buttons: Button.Interact });
    expect(a.state.arsenal.primary).toBe('shotgun');
    expect(a.state.arsenal.switchTimer).toBeGreaterThan(0);
    expect(sim.drops).toHaveLength(1);
    expect(sim.drops[0]!.primary).toBe('ar7');
    expect(sim.drops[0]!.ammoFraction).toBeCloseTo(
      oldAmmo / (PRIMARIES.ar7.magazineSize + PRIMARIES.ar7.reserveAmmo),
    );
    const own = sim.snapshot('a').players.find((p) => p.id === 'a')!;
    const remote = sim.snapshot('b').players.find((p) => p.id === 'a')!;
    expect(own.pr).toBe(PRIMARY_IDS.indexOf('shotgun'));
    expect(remote.pr).toBe(own.pr);
    expect(own.own?.guns[2]).toBe(a.state.guns.rifle.ammo);
    expect(remote.own).toBeUndefined();
    const discarded = sim.drops[0]!;
    const fraction = discarded.ammoFraction;
    expect(sim.snapshot('a').drops![0]).toMatchObject({ droppedBy: 'a', ownerClear: false });
    for (let i = 0; i < 3; i++) feed(sim, a);
    expect(a.state.arsenal.primary).toBe('shotgun');
    expect(discarded.ammoFraction).toBe(fraction);
    expect(sim.drainDrops().filter((e) => e.type === 'ammo')).toEqual([]);
    place(a, { ...discarded.pos, x: discarded.pos.x + WEAPON_DROP.pickupRadius + 0.2 });
    feed(sim, a);
    expect(sim.snapshot('a').drops![0]!.ownerClear).toBe(true);
    place(a, discarded.pos);
    feed(sim, a);
    expect(sim.drainDrops()).toContainEqual(expect.objectContaining({ type: 'ammo', by: 'a' }));
  });

  it('restores the chosen loadout and fresh ammo at respawn after a picked-up gun', () => {
    const sim = match();
    const a = sim.addPlayer('a', 'A', 0, false, { primary: 'iskra' });
    const b = sim.addPlayer('b', 'B', 0);
    place(a, { x: 0, y: 0, z: -22 });
    sim.spawnWeaponDrop('shotgun', 0, -22, 0.5);
    feed(sim, a, { buttons: Button.Interact });
    expect(a.state.arsenal.primary).toBe('shotgun');
    const discarded = sim.drops[0]!;
    expect(discarded.ownerClear).toBe(false);
    kill(sim, b, a);
    expect(discarded.ownerClear).toBe(true);
    sim.runTicks(Math.ceil(MATCH.respawnDelay * SIM.tickHz));
    expect(a.state.arsenal.primary).toBe('iskra');
    expect(a.state.guns.rifle.ammo).toBe(PRIMARIES.iskra.magazineSize);
    expect(a.state.guns.rifle.reserve).toBe(PRIMARIES.iskra.reserveAmmo);
    expect(a.lastRespawn?.primary).toBe('iskra');
  });

  it('clears the owner lock when buffered movement leaves and re-enters pickup range in one tick', () => {
    const sim = match();
    const a = sim.addPlayer('a', 'A', 0);
    place(a, { x: 0, y: 0, z: -22 });
    sim.spawnWeaponDrop('shotgun', 0, -22, 1);
    feed(sim, a, { buttons: Button.Interact });
    const discarded = sim.drops[0]!;
    expect(discarded).toMatchObject({ droppedBy: 'a', ownerClear: false });
    place(a, { ...discarded.pos, x: discarded.pos.x + WEAPON_DROP.pickupRadius - 0.005 });
    a.state.guns.rifle.reserve = PRIMARIES.shotgun.reserveAmmo - 1;
    sim.drainDrops();
    const ttl = discarded.ttl;
    const tick = sim.tick;
    const applied = a.applied;
    const seq = a.lastSeq + 1;
    const positions: Vec3[] = [];
    const move = a.body.move.bind(a.body);
    const movement = vi.spyOn(a.body, 'move').mockImplementation((...args) => {
      const result = move(...args);
      positions.push(a.body.position);
      return result;
    });

    expect(
      sim.receiveInputs(
        a.id,
        [1, -1, -1].map((moveX, i) => ({ ...emptyInput(seq + i), moveX })),
        sim.nowMs,
      ),
    ).toBe(3);
    // A delayed server tick earns all three inputs, but advances the drop clock only once.
    sim.step(3 * SIM_DT * 1000);
    movement.mockRestore();

    expect(sim.tick).toBe(tick + 1);
    expect(a.applied - applied).toBe(3);
    expect(a.ack).toBe(seq + 2);
    expect(positions).toHaveLength(3);
    expect(positions[0]!.x - discarded.pos.x).toBeGreaterThan(WEAPON_DROP.pickupRadius);
    expect(a.state.move.pos.x - discarded.pos.x).toBeLessThan(WEAPON_DROP.pickupRadius);
    expect(discarded.ownerClear).toBe(true);
    expect(sim.snapshot(a.id).drops![0]!.ownerClear).toBe(true);
    expect(a.state.guns.rifle.reserve).toBe(PRIMARIES.shotgun.reserveAmmo);
    expect(discarded.ttl).toBeCloseTo(ttl - SIM_DT, 10);
    expect(sim.drainDrops()).toEqual([{ type: 'ammo', dropId: discarded.id, by: a.id, amount: 1 }]);
  });

  it('drops bots’ guns but never lets bots take nearby drops', () => {
    const sim = match();
    const a = sim.addPlayer('a', 'A', 0);
    const b = sim.addPlayer('b', 'Bot', 0, true, { primary: 'shotgun' });
    place(b, { x: 0, y: 0, z: -22 });
    b.state.guns.rifle.ammo = 0;
    b.state.guns.rifle.reserve = 0;
    sim.spawnWeaponDrop('iskra', 0, -22, 1);
    feed(sim, b, { buttons: Button.Interact });
    expect(b.state.arsenal.primary).toBe('shotgun');
    expect(b.state.guns.rifle.reserve).toBe(0);
    expect(sim.drops).toHaveLength(1);
    b.state.guns.rifle.ammo = 2;
    kill(sim, a, b);
    expect(sim.drops.some((d) => d.primary === 'shotgun')).toBe(true);
  });

  it('automatically swaps a living empty player, but not a dead player', () => {
    const sim = match();
    const a = sim.addPlayer('a', 'A', 0);
    place(a, { x: 0, y: 0, z: -22 });
    a.state.guns.rifle.ammo = 0;
    a.state.guns.rifle.reserve = 0;
    sim.spawnWeaponDrop('shotgun', 0, -22, 0.5);
    feed(sim, a);
    expect(a.state.arsenal.primary).toBe('shotgun');
    expect(sim.drops).toHaveLength(0);
    a.state.health = 0;
    a.state.guns.rifle.ammo = 0;
    a.state.guns.rifle.reserve = 0;
    sim.spawnWeaponDrop('iskra', 0, -22, 0.5);
    feed(sim, a);
    expect(a.state.arsenal.primary).toBe('shotgun');
    expect(sim.drops).toHaveLength(1);
  });

  it('gives E to a nearby truck even when a gun is closer, and does not loot from a seat', () => {
    const sim = match({ vehicles: 'on', vehicleSpawns: [{ x: 0, z: -50, yaw: 0 }] });
    const a = sim.addPlayer('a', 'A', 0);
    place(a, { x: 1.6, y: 0.02, z: -49.6 });
    sim.spawnWeaponDrop('shotgun', 1.6, -49.6, 1);
    a.state.guns.rifle.reserve = 0;
    feed(sim, a, { buttons: Button.Interact });
    expect(a.state.seat?.vehicle).toBe(1);
    expect(a.state.arsenal.primary).toBe('ar7');
    expect(a.state.guns.rifle.reserve).toBe(0);
    expect(sim.drops).toHaveLength(1);
  });

  it('does not repeat swaps while E remains held', () => {
    const sim = match();
    const a = sim.addPlayer('a', 'A', 0);
    place(a, { x: 0, y: 0, z: -22 });
    sim.spawnWeaponDrop('shotgun', 0, -22, 1);
    feed(sim, a, { buttons: Button.Interact });
    feed(sim, a, { buttons: Button.Interact });
    expect(a.state.arsenal.primary).toBe('shotgun');
    expect(sim.drainDrops().filter((e) => e.type === 'swap')).toHaveLength(1);
  });

  it('keeps a same-input shot’s original primary after E swaps to a shotgun', () => {
    const fire = (swap: boolean) => {
      const sim = match();
      const a = sim.addPlayer('a', 'A', 0);
      const b = sim.addPlayer('b', 'B', 0);
      place(a, { x: 0, y: 0, z: -12 });
      place(b, { x: 0, y: 0, z: -22 });
      const pitch = Math.atan2(1.17 - a.state.move.eyeHeight, 10);
      for (let i = 0; i < 20; i++) feed(sim, a, { pitch, buttons: Button.Ads });
      if (swap) sim.spawnWeaponDrop('shotgun', 0, -12, 1);
      feed(sim, a, { pitch, buttons: Button.Ads | Button.Fire | (swap ? Button.Interact : 0) });
      expect(a.state.arsenal.primary).toBe(swap ? 'shotgun' : 'ar7');
      return sim.drainEvents().filter((e) => e.type === 'hit');
    };
    const regular = fire(false);
    const swapped = fire(true);
    expect(regular).toHaveLength(1);
    expect(swapped).toEqual(regular);
  });

  it('expires drops by match time and clears them for a fresh match', () => {
    const sim = match();
    sim.spawnWeaponDrop('ar7', 0, -22, 1);
    sim.runTicks(Math.ceil(WEAPON_DROP.ttl * SIM.tickHz) + 1);
    expect(sim.drops).toHaveLength(0);
    sim.spawnWeaponDrop('shotgun', 0, -22, 0.5);
    sim.endMatch();
    sim.runTicks(Math.ceil(MATCH.intermission * SIM.tickHz));
    expect(sim.phase).toBe('playing');
    expect(sim.snapshot().drops).toEqual([]);
  });

  it('rejects debug drops outside the map and in knife-only matches', () => {
    const sim = match();
    expect(sim.spawnWeaponDrop('ar7', 1e9, 0, 1)).toBe(false);
    expect(sim.spawnWeaponDrop('ar7', 0, -22, Number.NaN)).toBe(false);
    expect(sim.drops).toHaveLength(0);
    const knife = match({ mode: 'knife' });
    expect(knife.spawnWeaponDrop('ar7', 0, -22, 1)).toBe(false);
    expect(knife.drops).toHaveLength(0);
  });
});
