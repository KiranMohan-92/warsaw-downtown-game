import { describe, expect, it } from 'vitest';
import {
  Button,
  clonePlayerState,
  createPlayerState,
  createVehicleMotion,
  createWeaponDrops,
  emptyInput,
  motionToWire,
  PRIMARIES,
  SIM_DT,
  spawnDrop,
  stepDrops,
  stepPlayer,
  swapWithDrop,
  toSnapshotPlayer,
  WEAPON_DROP,
  type CharacterBody,
  type PlayerInput,
  type PlayerState,
  type Vec3,
  type WelcomeMessage,
} from '@wd/shared';
import { OnlineSession } from './onlineSession.ts';

class Flat implements CharacterBody {
  private feet = { x: 0, y: 0, z: 0 };
  move(d: Vec3) {
    const y = Math.max(0, this.feet.y + d.y);
    const moved = { x: d.x, y: y - this.feet.y, z: d.z };
    this.feet = { x: this.feet.x + d.x, y, z: this.feet.z + d.z };
    return { moved, grounded: y === 0 && d.y <= 0 };
  }
  setCrouched() {
    return true;
  }
  setPosition(pos: Vec3) {
    this.feet = { ...pos };
  }
}

const welcome: WelcomeMessage = {
  id: 'me',
  map: 'range',
  size: 'full',
  mode: 'standard',
  tick: 0,
  tickHz: 60,
  spawn: { x: 0, y: 0, z: 0, yaw: 0 },
  seed: 1,
  primary: 'ar7',
};

function setup(ammo = 15, reserve = 0) {
  const player = createPlayerState(welcome.spawn);
  player.guns.rifle.ammo = ammo;
  player.guns.rifle.reserve = reserve;
  const server = clonePlayerState(player);
  const drops = createWeaponDrops();
  spawnDrop(drops, 'coil', { x: 0.4, y: 0, z: 0 }, 0.5);
  const session = new OnlineSession();
  session.handleWelcome(welcome);
  const body = new Flat();
  const serverBody = new Flat();
  session.handleSnapshot(
    {
      t: 1,
      players: [toSnapshotPlayer('me', player, -1, 0, { own: true })],
      drops: drops.drops,
    },
    0,
  );
  const initial = session.reconcile(player, body, SIM_DT)?.state ?? player;
  return { session, player: initial, server, drops, body, serverBody };
}

function predict(ctx: ReturnType<typeof setup>, input: PlayerInput) {
  const previousButtons = ctx.player.prevButtons;
  stepPlayer(ctx.player, input, SIM_DT, ctx.body);
  ctx.session.predictDrops(ctx.player, input, previousButtons, SIM_DT);
  ctx.session.recordStep(input, ctx.player);
}

function serverStep(ctx: ReturnType<typeof setup>, input: PlayerInput) {
  const previousButtons = ctx.server.prevButtons;
  stepPlayer(ctx.server, input, SIM_DT, ctx.serverBody);
  const collector = { id: 'me', player: ctx.server };
  const manual =
    (input.buttons & Button.Interact) !== 0 && (previousButtons & Button.Interact) === 0
      ? swapWithDrop(ctx.drops, collector)
      : [];
  stepDrops(ctx.drops, [{ ...collector, skipAuto: manual.some((e) => e.type === 'swap') }], SIM_DT);
}

function expectSameGun(a: PlayerState, b: PlayerState) {
  expect(a.arsenal.primary).toBe(b.arsenal.primary);
  expect(a.guns.rifle).toEqual(b.guns.rifle);
  expect(a.arsenal.switchTimer).toBe(b.arsenal.switchTimer);
}

describe('weapon drop prediction', () => {
  it('predicts E swaps with the exact server gun, ammo, draw and returned gun', () => {
    const ctx = setup();
    const input = { ...emptyInput(0), buttons: Button.Interact };
    predict(ctx, input);
    serverStep(ctx, input);
    expectSameGun(ctx.player, ctx.server);
    expect(ctx.player.arsenal.primary).toBe('coil');
    expect(ctx.session.drops).toEqual(ctx.drops.drops);
    expect(ctx.session.takeDrops()).toEqual([]);
  });

  it('predicts ammo and empty auto-swaps through the same shared step as the server', () => {
    for (const ammo of [0, 1]) {
      const ctx = setup(ammo);
      const input = emptyInput(0);
      predict(ctx, input);
      serverStep(ctx, input);
      expectSameGun(ctx.player, ctx.server);
      expect(ctx.session.drops).toEqual(ctx.drops.drops);
      expect(ctx.player.arsenal.primary).toBe(ammo === 0 ? 'coil' : 'ar7');
    }
  });

  it('keeps an E-discarded gun locked across ticks and snapshot reconciliation until leaving', () => {
    const ctx = setup();
    const swap = { ...emptyInput(0), buttons: Button.Interact };
    predict(ctx, swap);
    serverStep(ctx, swap);
    const fraction = ctx.session.drops[0]!.ammoFraction;
    expect(ctx.session.drops[0]).toMatchObject({ droppedBy: 'me', ownerClear: false });
    for (let seq = 1; seq <= 3; seq++) {
      predict(ctx, emptyInput(seq));
      serverStep(ctx, emptyInput(seq));
      ctx.session.handleSnapshot(
        {
          t: seq + 1,
          players: [toSnapshotPlayer('me', ctx.server, seq, 0, { own: true })],
          drops: ctx.drops.drops,
        },
        seq * 20,
      );
      ctx.player = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!.state;
      expectSameGun(ctx.player, ctx.server);
      expect(ctx.session.drops[0]!.ammoFraction).toBe(fraction);
      expect(ctx.session.drops[0]!.ownerClear).toBe(false);
    }
    for (const [seq, x] of [
      [4, WEAPON_DROP.pickupRadius + 0.1],
      [5, 0],
    ] as const) {
      const pos = { x, y: 0, z: 0 };
      ctx.player.move.pos = { ...pos };
      ctx.server.move.pos = { ...pos };
      ctx.body.setPosition(pos);
      ctx.serverBody.setPosition(pos);
      predict(ctx, emptyInput(seq));
      serverStep(ctx, emptyInput(seq));
      expectSameGun(ctx.player, ctx.server);
      expect(ctx.session.drops).toEqual(ctx.drops.drops);
      expect(ctx.session.drops[0]!.ownerClear).toBe(true);
    }
    expect(ctx.player.guns.rifle.reserve).toBe(13);
  });

  it('corrects owner lock changes even when the gun and player snapshot are unchanged', () => {
    const ctx = setup();
    const swap = { ...emptyInput(0), buttons: Button.Interact };
    predict(ctx, swap);
    serverStep(ctx, swap);
    ctx.session.handleSnapshot(
      {
        t: 2,
        players: [toSnapshotPlayer('me', ctx.server, 0, 0, { own: true })],
        drops: ctx.drops.drops.map((d) => ({ ...d, ownerClear: true })),
      },
      20,
    );
    const corrected = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(corrected.corrected).toBe(true);
    expect(corrected.state.arsenal.primary).toBe('coil');
    expect(ctx.session.drops[0]).toMatchObject({ droppedBy: 'me', ownerClear: true });
  });

  it('does not predict a bounce when E takes an empty gun', () => {
    const ctx = setup(30, 120);
    ctx.drops.drops[0]!.ammoFraction = 0;
    ctx.session.handleSnapshot({ t: 2, players: [], drops: ctx.drops.drops }, 20);
    for (let seq = 0; seq < 4; seq++) {
      const input = { ...emptyInput(seq), buttons: seq === 0 ? Button.Interact : 0 };
      predict(ctx, input);
      serverStep(ctx, input);
      expectSameGun(ctx.player, ctx.server);
      expect(ctx.player.arsenal.primary).toBe('coil');
      expect(ctx.player.guns.rifle).toMatchObject({ ammo: 0, reserve: 0 });
      expect(ctx.session.drops[0]).toMatchObject({ primary: 'ar7', ammoFraction: 1 });
    }
  });

  it('releases old-life locks when a respawn arrives before its snapshot', () => {
    const ctx = setup();
    const swap = { ...emptyInput(0), buttons: Button.Interact };
    predict(ctx, swap);
    serverStep(ctx, swap);
    ctx.session.handleSnapshot({ t: 2, players: [], drops: ctx.drops.drops }, 20);
    ctx.session.handleRespawn({ life: 1, seq: 0, primary: 'ar7', x: 0, y: 0, z: 0, yaw: 0 });
    ctx.player = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!.state;
    expect(ctx.session.drops[0]).toMatchObject({ droppedBy: 'me', ownerClear: true });
    ctx.player.guns.rifle.reserve = 0;
    predict(ctx, emptyInput(1));
    expect(ctx.player.guns.rifle.reserve).toBe(15);
  });

  it.each([true, false])(
    'preserves new-life drop locks from the respawn snapshot (message: %s)',
    (withMessage) => {
      const ctx = setup();
      const fresh = createPlayerState(welcome.spawn);
      const drops = createWeaponDrops();
      spawnDrop(drops, 'coil', welcome.spawn, 0.5);
      swapWithDrop(drops, { id: 'me', player: fresh });
      if (withMessage)
        ctx.session.handleRespawn({ life: 1, seq: 0, primary: 'ar7', x: 0, y: 0, z: 0, yaw: 0 });
      ctx.session.handleSnapshot(
        {
          t: 2,
          players: [toSnapshotPlayer('me', fresh, 1, 1, { own: true })],
          drops: drops.drops,
        },
        20,
      );
      ctx.player = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!.state;
      expect(ctx.session.drops[0]).toMatchObject({ droppedBy: 'me', ownerClear: false });
      predict(ctx, emptyInput(2));
      expect(ctx.player.guns.rifle.reserve).toBe(10);
      expect(ctx.session.drops[0]!.ammoFraction).toBe(1);
    },
  );

  it('replays an unacknowledged swap after a correction, then accepts its acknowledgement', () => {
    const ctx = setup(15, PRIMARIES.ar7.reserveAmmo);
    const first = emptyInput(0);
    predict(ctx, first);
    serverStep(ctx, first);
    const baseline = toSnapshotPlayer('me', ctx.server, 0, 0, { own: true });
    const oldDrops = ctx.drops.drops.map((d) => ({ ...d, pos: { ...d.pos } }));
    const swap = { ...emptyInput(1), buttons: Button.Interact };
    predict(ctx, swap);
    ctx.session.handleSnapshot({ t: 2, players: [baseline], drops: oldDrops }, 20);
    const replayed = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(replayed.corrected).toBe(true);
    ctx.player = replayed.state;
    serverStep(ctx, swap);
    expectSameGun(ctx.player, ctx.server);
    expect(ctx.session.drops).toEqual(ctx.drops.drops);
    ctx.session.handleSnapshot(
      {
        t: 3,
        players: [toSnapshotPlayer('me', ctx.server, 1, 0, { own: true })],
        drops: ctx.drops.drops,
      },
      40,
    );
    const confirmed = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(confirmed.corrected).toBe(false);
    expectSameGun(confirmed.state, ctx.server);
    expect(ctx.session.primary).toBe('coil');
  });

  it('removes a rejected predicted swap when someone else took the gun first', () => {
    const ctx = setup();
    predict(ctx, { ...emptyInput(0), buttons: Button.Interact });
    ctx.session.handleSnapshot(
      {
        t: 2,
        players: [toSnapshotPlayer('me', ctx.server, -1, 0, { own: true })],
        drops: [],
      },
      20,
    );
    const corrected = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(corrected.state.arsenal.primary).toBe('ar7');
    expect(ctx.session.drops).toEqual([]);
  });

  it('converges when a server input batch collects ammo only after both inputs', () => {
    const ctx = setup();
    const inputs = [emptyInput(0), { ...emptyInput(1), buttons: Button.Interact }];
    for (const input of inputs) predict(ctx, input);
    // Prediction consumed the drop's ammo on the first input, then took its empty gun.
    expect(ctx.player.guns.rifle.ammo + ctx.player.guns.rifle.reserve).toBe(0);

    const collector = { id: 'me', player: ctx.server };
    let manuallySwapped = false;
    // MatchSim can consume both queued inputs in one server tick. It handles each E edge,
    // then runs auto collection once after the entire batch, skipping manual swappers.
    for (const input of inputs) {
      const previousButtons = ctx.server.prevButtons;
      stepPlayer(ctx.server, input, SIM_DT, ctx.serverBody);
      if ((input.buttons & Button.Interact) !== 0 && (previousButtons & Button.Interact) === 0) {
        const events = swapWithDrop(ctx.drops, collector);
        manuallySwapped ||= events.some((event) => event.type === 'swap');
      }
    }
    stepDrops(ctx.drops, [{ ...collector, skipAuto: manuallySwapped }], SIM_DT);
    expect(ctx.server.guns.rifle.ammo + ctx.server.guns.rifle.reserve).toBe(15);
    expect(ctx.drops.drops[0]!.ammoFraction).toBe(0.1);

    const snapshot = toSnapshotPlayer('me', ctx.server, 1, 0, { own: true });
    ctx.session.handleSnapshot({ t: 2, players: [snapshot], drops: ctx.drops.drops }, 20);
    const corrected = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(corrected.corrected).toBe(true);
    ctx.player = corrected.state;
    expectSameGun(ctx.player, ctx.server);
    expect(ctx.session.drops).toEqual(ctx.drops.drops);

    ctx.session.handleSnapshot({ t: 3, players: [snapshot], drops: ctx.drops.drops }, 40);
    const settled = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(settled.corrected).toBe(false);
    expectSameGun(settled.state, ctx.server);
    expect(ctx.session.drops).toEqual(ctx.drops.drops);

    const next = emptyInput(2);
    predict(ctx, next);
    serverStep(ctx, next);
    ctx.session.handleSnapshot(
      {
        t: 4,
        players: [toSnapshotPlayer('me', ctx.server, 2, 0, { own: true })],
        drops: ctx.drops.drops,
      },
      60,
    );
    const resumed = ctx.session.reconcile(ctx.player, ctx.body, SIM_DT)!;
    expect(resumed.corrected).toBe(false);
    expectSameGun(resumed.state, ctx.server);
    expect(ctx.session.drops).toEqual(ctx.drops.drops);
  });

  it('preserves truck priority for E and queues confirmed feedback once', () => {
    const ctx = setup(15, PRIMARIES.ar7.reserveAmmo);
    ctx.session.handleSnapshot(
      {
        t: 2,
        players: [],
        vehicles: [
          { id: 0, m: motionToWire(createVehicleMotion({ x: 0, y: 0, z: 0 }, 0)), hp: 100, st: 0 },
        ],
      },
      20,
    );
    expect(ctx.session.dropTruckPriority(ctx.player)).toBe(true);
    predict(ctx, { ...emptyInput(0), buttons: Button.Interact });
    expect(ctx.player.arsenal.primary).toBe('ar7');
    const event = { type: 'ammo', by: 'me', dropId: 'drop-1', amount: 12 } as const;
    ctx.session.handleDrops({ events: [event] });
    expect(ctx.session.takeDrops()).toEqual([event]);
    expect(ctx.session.takeDrops()).toEqual([]);
  });

  it('keeps expiring drops without collecting them after the match ends', () => {
    const ctx = setup(0);
    ctx.session.handleMatch({
      phase: 'ended',
      endsAt: 60,
      scoreLimit: 25,
      scores: [],
      winners: [],
    });
    predict(ctx, { ...emptyInput(0), buttons: Button.Interact });
    expect(ctx.player.arsenal.primary).toBe('ar7');
    expect(ctx.player.guns.rifle.reserve).toBe(0);
    expect(ctx.session.drops[0]!.ttl).toBe(30 - SIM_DT);
  });
});
