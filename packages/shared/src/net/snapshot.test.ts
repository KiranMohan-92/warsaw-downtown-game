import { describe, expect, it } from 'vitest';
import { DRONE, GRENADE, PRIMARY_IDS, SIM_DT, SPAWN_PROTECTION } from '../config/tunables.ts';
import { Button, emptyInput, type PlayerInput } from '../sim/input.ts';
import {
  clonePlayerState,
  createPlayerState,
  stepPlayer,
  type PlayerState,
} from '../sim/player.ts';
import { FlatGroundBody } from '../sim/testUtils.ts';
import { grantSpawnProtection } from '../sim/spawnProtection.ts';
import { SnapFlag } from './protocol.ts';
import { reconcile, type PredictedStep } from './reconcile.ts';
import {
  applyOwnState,
  applySnapshotMove,
  ownState,
  snapshotAction,
  snapshotError,
  snapshotPrimary,
  snapshotProtected,
  toSnapshotDrone,
  toSnapshotPlayer,
  traversalFromWire,
  traversalToWire,
} from './snapshot.ts';

function predict(
  start: PlayerState,
  list: PlayerInput[],
): { state: PlayerState; pending: PredictedStep[] } {
  const state = clonePlayerState(start);
  const body = new FlatGroundBody(start.move.pos);
  const pending: PredictedStep[] = [];
  for (const input of list) {
    stepPlayer(state, input, SIM_DT, body);
    pending.push({ input, after: clonePlayerState(state) });
  }
  return { state, pending };
}

/** Start a vault right here, heading -Z (what the server's ledge probe would have set up). */
function startVault(p: PlayerState): void {
  const f = { ...p.move.pos };
  p.move.traversal = {
    kind: 'vault',
    t: 0,
    dur: 0.42,
    from: f,
    path: [
      { x: f.x, y: f.y + 1.1, z: f.z + 0.05 },
      { x: f.x, y: f.y + 1.1, z: f.z - 1.6 },
      { x: f.x, y: f.y + 0.02, z: f.z - 1.6 },
    ],
    to: { x: f.x, y: f.y + 0.02, z: f.z - 1.6 },
    dir: { x: 0, z: -1 },
  };
}

describe('snapshot: climbs and vaults on the wire (M3a review fix)', () => {
  it('round-trips the whole fixed path', () => {
    const p = createPlayerState({ x: 3, y: 1, z: -2 });
    startVault(p);
    p.move.traversal!.t = 0.1;
    const wire = traversalToWire(p.move.traversal!);
    expect(traversalFromWire(wire, 0.1)).toEqual(p.move.traversal);
    // Malformed entries are refused (the caller keeps its own).
    expect(traversalFromWire({ ...wire, path: [1, 2] }, 0)).toBeNull();
    expect(traversalFromWire({ ...wire, dur: 0 }, 0)).toBeNull();
    expect(traversalFromWire({ ...wire, to: [0, Number.NaN, 0] }, 0)).toBeNull();
  });

  it('a vault the server started but the client never predicted is rebuilt and replayed exactly', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = Array.from({ length: 30 }, (_, i) => ({ ...emptyInput(i), moveZ: 1 }));
    // The client never saw the ledge (no vault in its prediction).
    const client = predict(start, list);
    expect(client.pending.every((s) => s.after.move.traversal === null)).toBe(true);

    // The server: inputs 0–9, then a vault starts, then inputs 10–14 carry it along.
    const server = clonePlayerState(start);
    const sbody = new FlatGroundBody(start.move.pos);
    for (let i = 0; i < 10; i++) stepPlayer(server, list[i]!, SIM_DT, sbody);
    startVault(server);
    for (let i = 10; i < 15; i++) stepPlayer(server, list[i]!, SIM_DT, sbody);
    const snap = toSnapshotPlayer('me', server, 14, 0);
    expect(snap.tr).toBeDefined();

    const body = new FlatGroundBody();
    const r = reconcile(client.state, client.pending, snap, body, SIM_DT);
    expect(r.corrected).toBe(true);
    // The truth: the server carrying on with inputs 15–29 (still mid-vault at 0.42 s).
    const truth = clonePlayerState(server);
    for (let i = 15; i < 30; i++) stepPlayer(truth, list[i]!, SIM_DT, sbody);
    expect(truth.move.traversal).not.toBeNull();
    expect(r.state.move.traversal).toEqual(truth.move.traversal);
    expect(r.state.move.pos.x).toBeCloseTo(truth.move.pos.x, 9);
    expect(r.state.move.pos.y).toBeCloseTo(truth.move.pos.y, 9);
    expect(r.state.move.pos.z).toBeCloseTo(truth.move.pos.z, 9);
    // The replay moved the body along the same path.
    expect(body.feet.z).toBeCloseTo(truth.move.pos.z, 9);
  });

  it('a climb predicted along a different path counts as a misprediction', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    startVault(p);
    const server = clonePlayerState(p);
    expect(snapshotError(p, toSnapshotPlayer('me', server, 0, 0))).toBe(0);
    server.move.traversal!.to = { x: 0, y: 1.2, z: -1 }; // the server mantled onto a ledge instead
    expect(snapshotError(p, toSnapshotPlayer('me', server, 0, 0))).toBeGreaterThan(0.5);
    const q = clonePlayerState(p);
    applySnapshotMove(q, toSnapshotPlayer('me', server, 0, 0));
    expect(q.move.traversal!.to).toEqual({ x: 0, y: 1.2, z: -1 });
  });

  it('corrects a different waypoint even when the endpoint and current position agree', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    startVault(p);
    const server = clonePlayerState(p);
    server.move.traversal!.path[0]!.y += 0.4;
    const snap = toSnapshotPlayer('me', server, 0, 0);
    expect(snapshotError(p, snap)).toBeGreaterThan(0.3);
    applySnapshotMove(p, snap);
    expect(p.move.traversal).toEqual(server.move.traversal);
  });
});

describe('snapshot: weapon and kit state in the correction (M3a review fix)', () => {
  // Standing still, pressing Fire at input 5 and the frag at input 6. The server skipped those
  // two inputs (late after a stall): movement is identical, only the counts differ.
  const list: PlayerInput[] = Array.from({ length: 20 }, (_, i) => ({
    ...emptyInput(i),
    buttons: i === 5 ? Button.Fire : i === 6 ? Button.Grenade : 0,
  }));

  function serverSkipping(skip: Set<number>, upTo: number): PlayerState {
    const s = createPlayerState({ x: 0, y: 0, z: 0 });
    const body = new FlatGroundBody();
    for (let i = 0; i <= upTo; i++) {
      if (skip.has(i))
        s.prevButtons = list[i]!.buttons; // acknowledged unapplied
      else stepPlayer(s, list[i]!, SIM_DT, body);
    }
    return s;
  }

  it('without it a skipped shot and throw stay wrong for good; with it they are corrected', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const client = predict(start, list);
    expect(client.state.guns.rifle.ammo).toBe(29);
    expect(client.state.arsenal.grenades).toBe(GRENADE.perLife - 1);
    const server = serverSkipping(new Set([5, 6]), 11);
    expect(server.guns.rifle.ammo).toBe(30);

    // Movement agrees, so a movement-only snapshot sees nothing to correct...
    const acked = client.pending[11]!.after;
    expect(snapshotError(acked, toSnapshotPlayer('me', server, 11, 0))).toBe(0);
    // ...the player's own snapshot carries the counts, and the difference forces a rebuild.
    const own = toSnapshotPlayer('me', server, 11, 0, { own: true });
    expect(own.own).toEqual(ownState(server));
    expect(snapshotError(acked, own)).toBe(Infinity);

    const r = reconcile(client.state, client.pending, own, new FlatGroundBody(), SIM_DT);
    expect(r.corrected).toBe(true);
    expect(r.state.guns.rifle.ammo).toBe(30);
    expect(r.state.guns.rifle.shotCounter).toBe(0); // spread seeds back in step with the server
    expect(r.state.arsenal.grenades).toBe(GRENADE.perLife);
    // The throw the server never started is called off (no phantom frag leaves the hand).
    expect(client.state.arsenal.throwPhase).not.toBe('idle');
    expect(r.state.arsenal.throwPhase).toBe('idle');
    // From then on the prediction agrees with the server again (no correction loop).
    const later = serverSkipping(new Set([5, 6]), 19);
    const next = toSnapshotPlayer('me', later, 19, 0, { own: true });
    expect(snapshotError(r.pending.at(-1)!.after, next)).toBe(0);
  });

  it('a stun the server applied (the attacker was parried) is taken over too', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const server = clonePlayerState(p);
    server.arsenal.stun = 0.7;
    server.arsenal.guard.blocks = 2;
    const snap = toSnapshotPlayer('me', server, 0, 0, { own: true });
    expect(snapshotError(p, snap)).toBe(Infinity);
    applySnapshotMove(p, snap);
    expect(p.arsenal.stun).toBe(0.7);
    expect(p.arsenal.guard.blocks).toBe(2);
    expect(snapshotError(p, snap)).toBe(0);
  });

  it('other players never get anyone else’s weapon state', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    expect(toSnapshotPlayer('bo', p, 3, 0).own).toBeUndefined();
  });

  it('a skipped shot corrects recoil and trigger state before the next predicted shot', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const inputs = Array.from({ length: 18 }, (_, seq) => ({
      ...emptyInput(seq),
      buttons: seq >= 5 ? Button.Fire : 0,
    }));
    const client = predict(start, inputs);
    const server = clonePlayerState(start);
    const body = new FlatGroundBody();
    for (let i = 0; i <= 5; i++) {
      if (i === 5) server.prevButtons = inputs[i]!.buttons;
      else stepPlayer(server, inputs[i]!, SIM_DT, body);
    }
    const snap = toSnapshotPlayer('me', server, 5, 0, { own: true });
    const r = reconcile(client.state, client.pending, snap, new FlatGroundBody(), SIM_DT);
    for (let i = 6; i < inputs.length; i++) stepPlayer(server, inputs[i]!, SIM_DT, body);
    expect(r.state.guns).toEqual(server.guns);
    expect(r.state.arsenal).toEqual(server.arsenal);
  });

  it('reconstructs an unpredicted smoke throw and knife combo for identical later events', () => {
    const server = createPlayerState({ x: 0, y: 0, z: 0 });
    const body = new FlatGroundBody();
    stepPlayer(server, { ...emptyInput(0), buttons: Button.Smoke }, SIM_DT, body);
    server.arsenal.melee = {
      ...server.arsenal.melee,
      move: 'thrust',
      combo: 3,
      swings: 2,
      quick: true,
      sinceStrike: 0.2,
      windupTotal: 0.07,
      empowered: true,
    };
    const client = createPlayerState({ x: 0, y: 0, z: 0 });
    const snap = toSnapshotPlayer('me', server, 0, 0, { own: true });
    applySnapshotMove(client, snap);
    expect(client.arsenal).toEqual(server.arsenal);
    expect(client.prevButtons).toBe(server.prevButtons);
    const cbody = new FlatGroundBody(client.move.pos);
    for (let seq = 1; seq < 25; seq++) {
      expect(stepPlayer(client, emptyInput(seq), SIM_DT, cbody)).toEqual(
        stepPlayer(server, emptyInput(seq), SIM_DT, body),
      );
    }
    expect(client).toEqual(server);
  });
});

describe('snapshot: health and death are the server’s', () => {
  it('damage the client could not predict forces a rebuild with the server’s health', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = Array.from({ length: 10 }, (_, i) => ({ ...emptyInput(i), moveZ: 1 }));
    const client = predict(start, list);
    const server = clonePlayerState(client.pending[4]!.after);
    server.health = 75;
    const r = reconcile(
      client.state,
      client.pending,
      toSnapshotPlayer('me', server, 4, 0),
      new FlatGroundBody(),
      SIM_DT,
    );
    expect(r.corrected).toBe(true);
    expect(r.state.health).toBe(75);
    expect(r.state.move.pos.z).toBeCloseTo(client.state.move.pos.z, 9); // movement unchanged
  });

  it('the dead do not act: no movement, aim, shots or throws until the respawn', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    p.health = 0;
    const before = clonePlayerState(p);
    const body = new FlatGroundBody();
    for (let i = 0; i < 30; i++) {
      const events = stepPlayer(
        p,
        { seq: i, moveX: 0, moveZ: 1, yaw: 1, pitch: 0.2, buttons: Button.Fire | Button.Grenade },
        SIM_DT,
        body,
      );
      expect(events).toEqual([]);
    }
    expect(p.move).toEqual(before.move);
    expect(p.view).toEqual(before.view);
    expect(p.guns).toEqual(before.guns);
    expect(p.arsenal).toEqual(before.arsenal);
  });

  it('a death the client learns late: the replay freezes it where the server killed it', () => {
    const start = createPlayerState({ x: 0, y: 0, z: 0 });
    const list = Array.from({ length: 20 }, (_, i) => ({ ...emptyInput(i), moveZ: 1 }));
    const client = predict(start, list);
    const server = clonePlayerState(client.pending[7]!.after);
    server.health = 0;
    const r = reconcile(
      client.state,
      client.pending,
      toSnapshotPlayer('me', server, 7, 0),
      new FlatGroundBody(),
      SIM_DT,
    );
    expect(r.corrected).toBe(true);
    expect(r.state.health).toBe(0);
    expect(r.state.move.pos).toEqual(server.move.pos);
  });
});

describe('own state: coilgun charge and loadout primary', () => {
  it('round-trips the charge and the primary (a wrong-gun life is corrected)', () => {
    const server = createPlayerState({ x: 0, y: 0, z: 0 }, 3, 'standard', 'coil');
    server.guns.rifle.charge = 0.12;
    const client = createPlayerState({ x: 0, y: 0, z: 0 }, 3, 'standard', 'ar7');
    applyOwnState(client, ownState(server));
    expect(client.arsenal.primary).toBe('coil');
    expect(client.guns.rifle.charge).toBeCloseTo(0.12, 6);
  });
});

describe('own state: recon drone prediction state', () => {
  it('round-trips drone charges and exact flight state only for the owner', () => {
    const server = createPlayerState({ x: 0, y: 0, z: 0 }, 12);
    const body = new FlatGroundBody();
    Object.defineProperty(body, 'world', { value: { castRay: () => null } });
    server.droneCharges = 1;
    stepPlayer(server, { ...emptyInput(0), buttons: Button.Drone, yaw: 0.4 }, SIM_DT, body);
    for (let i = 1; i < 20; i++) {
      stepPlayer(server, { ...emptyInput(i), moveZ: 1, yaw: 0.4, pitch: 0.1 }, SIM_DT, body);
    }
    expect(server.drone).not.toBeNull();

    const other = toSnapshotPlayer('bo', server, 19, 0);
    expect(other.own).toBeUndefined();
    const own = toSnapshotPlayer('me', server, 19, 0, { own: true });
    expect(own.own!.dc).toBeUndefined();
    expect(own.own!.dr).toHaveLength(11);

    const client = createPlayerState({ x: 0, y: 0, z: 0 }, 12);
    client.droneCharges = 1;
    applySnapshotMove(client, own);
    expect(client.droneCharges).toBe(0);
    expect(client.drone).toEqual(server.drone);
    expect(snapshotError(client, own)).toBe(0);

    client.drone!.pos.x += 0.5;
    expect(snapshotError(client, own)).toBeCloseTo(0.5, 9);
    client.drone = null;
    expect(snapshotError(client, own)).toBe(Infinity);
  });

  it('compact public drone snapshots bucket the battery', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 }, 2);
    p.drone = {
      owner: 2,
      pos: { x: 1, y: 2, z: 3 },
      vel: { x: 0, y: 0, z: 0 },
      yaw: 0.75,
      pitch: 0,
      battery: DRONE.battery / 2,
      baseY: 0,
      alive: true,
    };
    expect(toSnapshotDrone('p2', p.drone)).toEqual(['p2', 1, 2, 3, 0.75, 128]);
  });
});

describe('snapshot: every entry carries the primary in hand (third-person guns)', () => {
  it('encodes each primary as its PRIMARY_IDS index, in own and other entries alike', () => {
    for (const [i, id] of PRIMARY_IDS.entries()) {
      const p = createPlayerState({ x: 0, y: 0, z: 0 }, 3, 'standard', id);
      const other = toSnapshotPlayer('bo', p, 3, 0);
      expect(other.pr).toBe(i);
      expect(other.own).toBeUndefined();
      expect(snapshotPrimary(other)).toBe(id);
      expect(toSnapshotPlayer('me', p, 3, 0, { own: true }).pr).toBe(i);
    }
  });

  it('decodes an unknown, fractional or missing index as the AR-7 (older/newer peers)', () => {
    expect(snapshotPrimary({ pr: PRIMARY_IDS.length })).toBe('ar7');
    expect(snapshotPrimary({ pr: -1 })).toBe('ar7');
    expect(snapshotPrimary({ pr: 1.5 })).toBe('ar7');
    expect(snapshotPrimary({} as { pr: number })).toBe('ar7');
  });

  it('keeps the index order append-only (the wire depends on it)', () => {
    expect(PRIMARY_IDS.slice(0, 6)).toEqual(['ar7', 'coil', 'iskra', 'shotgun', 'marksman', 'arc']);
  });
});

describe('snapshot: every entry carries the visible action (third-person animation)', () => {
  it('omits it when idle and packs a reload or throw in progress for everyone', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const idle = toSnapshotPlayer('bo', p, 3, 0);
    expect(idle.ac).toBeUndefined();
    expect(snapshotAction(idle).kind).toBe('none');
    p.guns.rifle.ammo = 2;
    const body = new FlatGroundBody();
    stepPlayer(p, { ...emptyInput(0), buttons: Button.Reload }, SIM_DT, body);
    for (let i = 1; i < 40; i++) stepPlayer(p, emptyInput(i), SIM_DT, body);
    const other = toSnapshotPlayer('bo', p, 3, 0);
    expect(other.own).toBeUndefined(); // public entry: the action is all it says about the hands
    const a = snapshotAction(other);
    expect(a.kind).toBe('reload');
    expect(a.t).toBeCloseTo(1 - p.guns.rifle.reloadTimer / p.guns.rifle.reloadDuration, 1);
    // Applying a snapshot never feeds the action back into the sim (presentation only).
    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(q, other);
    expect(q.guns.rifle.reloadTimer).toBe(0);
    const t = createPlayerState({ x: 0, y: 0, z: 0 });
    stepPlayer(t, { ...emptyInput(0), buttons: Button.Grenade }, SIM_DT, body);
    expect(GRENADE.windup).toBeGreaterThan(SIM_DT);
    expect(snapshotAction(toSnapshotPlayer('t', t, 0, 0)).kind).toBe('throw');
  });
});

describe('spawn protection on the wire', () => {
  it.each([SPAWN_PROTECTION.duration, SPAWN_PROTECTION.duration - SIM_DT / 2, SIM_DT / 2])(
    'round-trips %s seconds without clamping or quantising the own timer',
    (seconds) => {
      const server = createPlayerState({ x: 0, y: 0, z: 0 });
      grantSpawnProtection(server, seconds);
      const snap = toSnapshotPlayer('a', server, 0, 0, { own: true });
      // Snapshot fields are plain numbers: no timer-specific integer packing or range.
      const wire = JSON.parse(JSON.stringify(snap)) as typeof snap;
      expect(wire.own!.sg).toBe(seconds);
      const client = createPlayerState({ x: 0, y: 0, z: 0 });
      applySnapshotMove(client, wire);
      expect(client.spawnGuard).toBe(seconds);
      expect(snapshotProtected(wire)).toBe(true);
    },
  );

  it('a flag bit for everyone, the time left only in the own entry', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    expect(snapshotProtected(toSnapshotPlayer('a', p, 0, 0))).toBe(false);
    expect(toSnapshotPlayer('a', p, 0, 0, { own: true }).own!.sg).toBeUndefined(); // omitted at 0
    grantSpawnProtection(p);
    p.spawnGuard = 1.25;
    const other = toSnapshotPlayer('a', p, 0, 0);
    expect(other.f & SnapFlag.Protected).toBe(SnapFlag.Protected);
    expect(snapshotProtected(other)).toBe(true);
    expect(other.own).toBeUndefined();
    const own = toSnapshotPlayer('a', p, 0, 0, { own: true });
    expect(own.own!.sg).toBe(1.25);
    // The dead are never flagged (a corpse can't shimmer).
    p.health = 0;
    expect(snapshotProtected(toSnapshotPlayer('a', p, 0, 0))).toBe(false);
  });

  it('decodes safely: the own timer is adopted, junk reads as none, others follow the flag', () => {
    const server = createPlayerState({ x: 0, y: 0, z: 0 });
    grantSpawnProtection(server, 0.8);
    const own = toSnapshotPlayer('a', server, 0, 0, { own: true });
    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(q, own);
    expect(q.spawnGuard).toBe(0.8);
    for (const junk of [Number.NaN, -1, Infinity, '2' as unknown as number]) {
      const r = createPlayerState({ x: 0, y: 0, z: 0 });
      grantSpawnProtection(r);
      applySnapshotMove(r, { ...own, own: { ...own.own!, sg: junk } });
      expect(r.spawnGuard).toBe(0);
    }
    // A public entry without the flag clears it; with the flag it is left as predicted.
    const r = createPlayerState({ x: 0, y: 0, z: 0 });
    grantSpawnProtection(r);
    applySnapshotMove(r, toSnapshotPlayer('a', server, 0, 0));
    expect(r.spawnGuard).toBe(SPAWN_PROTECTION.duration);
    applySnapshotMove(r, toSnapshotPlayer('a', createPlayerState({ x: 0, y: 0, z: 0 }), 0, 0));
    expect(r.spawnGuard).toBe(0);
    // Unknown higher flag bits are ignored by old and new decoders alike.
    const odd = { ...toSnapshotPlayer('a', q, 0, 0), f: SnapFlag.Grounded | (1 << 12) };
    expect(snapshotProtected(odd)).toBe(false);
  });

  it('prediction error: on/off must match, the timer alone never forces a replay', () => {
    const server = createPlayerState({ x: 0, y: 0, z: 0 });
    grantSpawnProtection(server);
    const s = toSnapshotPlayer('a', server, 0, 0, { own: true });
    const client = clonePlayerState(server);
    expect(snapshotError(client, s)).toBe(0);
    client.spawnGuard = SPAWN_PROTECTION.duration - SIM_DT; // a pause: no correction
    expect(snapshotError(client, s)).toBe(0);
    client.spawnGuard = 0; // the client never granted it (or ended it): correct
    expect(snapshotError(client, s)).toBe(Infinity);
  });
});

describe('snapshot: slides', () => {
  /** Sprint forward 1 s, then Crouch: 0.2 s into a slide. */
  const sliding = (): PlayerState => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const body = new FlatGroundBody();
    const s = Button.Sprint;
    for (let i = 0; i < 82; i++) {
      const buttons = i < 6 ? 0 : i < 66 ? s : s | Button.Crouch;
      stepPlayer(p, { ...emptyInput(i), moveZ: i < 6 ? 0 : 1, buttons }, SIM_DT, body);
    }
    expect(p.move.sliding).toBe(true);
    return p;
  };

  it('flags a slide in every entry; the own entry carries its timers (cooldown too)', () => {
    const p = sliding();
    const other = toSnapshotPlayer('x', p, 5, 0);
    expect(other.f & SnapFlag.Sliding).not.toBe(0);
    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(q, other);
    expect(q.move.sliding).toBe(true);
    expect(q.move.crouched).toBe(true);

    const own = toSnapshotPlayer('x', p, 5, 0, { own: true });
    const r = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(r, own);
    expect(r.move.slideTime).toBe(p.move.slideTime);
    // A wrong cooldown would let the client predict a slide the server refuses: it's carried.
    const done = clonePlayerState(p);
    done.move.sliding = false;
    done.move.slideCooldown = 0.5;
    const r2 = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(r2, toSnapshotPlayer('x', done, 5, 0, { own: true }));
    expect(r2.move.slideCooldown).toBe(0.5);
  });

  it('a slide the client did not predict (or predicted wrongly) is a stance mismatch', () => {
    const p = sliding();
    const snap = toSnapshotPlayer('x', p, 5, 0, { own: true });
    expect(snapshotError(clonePlayerState(p), snap)).toBe(0);
    const mine = clonePlayerState(p);
    mine.move.sliding = false;
    expect(snapshotError(mine, snap)).toBe(Infinity);
    const late = clonePlayerState(p);
    late.move.slideTime += 0.1;
    expect(snapshotError(late, snap)).toBeCloseTo(0.1, 9);
  });

  it('Sliding has its own bit past the first byte and round-trips independently of bit 7', () => {
    expect(SnapFlag.Sliding).toBe(1 << 8);
    const bits = Object.values(SnapFlag);
    expect(new Set(bits).size).toBe(bits.length); // no two flags share a bit
    const bit7 = SnapFlag.Protected; // bit 7
    const p = sliding();
    for (const [slide, other] of [
      [true, false],
      [true, true],
      [false, true],
    ] as const) {
      const src = clonePlayerState(p);
      src.move.sliding = slide;
      const snap = toSnapshotPlayer('x', src, 5, 0);
      if (other) snap.f |= bit7;
      // The wire is JSON-shaped numbers (msgpack integers): nothing truncates `f` to a byte.
      const wire = JSON.parse(JSON.stringify(snap)) as typeof snap;
      expect(wire.f & bit7, `bit 7 (${slide}, ${other})`).toBe(other ? bit7 : 0);
      const q = createPlayerState({ x: 0, y: 0, z: 0 });
      applySnapshotMove(q, wire);
      expect(q.move.sliding, `sliding (${slide}, ${other})`).toBe(slide);
    }
  });

  it('unknown flag bits (a newer server) are ignored', () => {
    const p = createPlayerState({ x: 0, y: 0, z: 0 });
    const snap = toSnapshotPlayer('x', p, 0, 0);
    snap.f |= 1 << 12;
    const q = createPlayerState({ x: 0, y: 0, z: 0 });
    applySnapshotMove(q, snap);
    expect(q.move.sliding).toBe(false);
    expect(q.move.prone).toBe(false);
  });
});
