import { describe, expect, it } from 'vitest';
import { createPlayerState, createTactical, launchDrone, type PlayerState } from '@wd/shared';
import { Game } from './Game.ts';

/**
 * `Game.reconcileOnline` across a respawn: the server's state for the new life may already carry
 * a live drone (a delayed respawn snapshot, or replayed inputs that launched one). It must stay
 * up; only the old life's flight presentation ends.
 */
function respawnInto(next: PlayerState, oldFlying: boolean) {
  const old = createPlayerState({ x: 0, y: 0, z: 0 }, 1);
  if (oldFlying) old.drone = launchDrone(1, { x: 0, y: 2, z: 0 }, 0.3);
  let life = 1;
  const calls: string[] = [];
  const game = {
    player: old,
    body: {},
    online: {
      get currentLife() {
        return life;
      },
      reconcile: () => {
        life = 2;
        return { corrected: true, state: next };
      },
    },
    tactical: createTactical<string>(),
    input: { yaw: 0.3, pitch: 0.1 },
    savedView: oldFlying ? { yaw: 9, pitch: 9 } : null,
    dronePrev: oldFlying ? { x: 1, y: 2, z: 3 } : null,
    audio: { droneStart: () => calls.push('start'), droneStop: () => calls.push('stop') },
    hud: { banner: () => calls.push('banner') },
    correction: { correct: () => 'snap' },
    prev: old,
    lastFeetY: null,
    onlineSpottedIds: new Set<string>(),
    director: { respawned: () => calls.push('respawned') },
    replay: { unfreeze: () => {} },
  };
  Object.setPrototypeOf(game, Game.prototype);
  (Game.prototype as unknown as { reconcileOnline(this: unknown): void }).reconcileOnline.call(
    game,
  );
  return { game, calls };
}

describe('online respawn reconcile and the recon drone', () => {
  it('keeps a live drone the new life already carries, flown from its own view', () => {
    const next = createPlayerState({ x: 10, y: 0, z: 10 }, 1);
    next.view.yaw = 1.5;
    next.view.pitch = -0.2;
    next.drone = launchDrone(1, { x: 10, y: 2, z: 10 }, 0.7);
    next.drone.pitch = 0.25;
    const { game } = respawnInto(next, true);
    expect(game.player.drone?.alive).toBe(true);
    expect(game.tactical.drone).toBe(next.drone);
    // Inputs keep flying it; landing returns to the new body's view, not the old life's.
    expect(game.input).toEqual({ yaw: 0.7, pitch: 0.25 });
    expect(game.savedView).toEqual({ yaw: 1.5, pitch: -0.2 });
    expect(game.dronePrev).toBeNull();
  });

  it('a new life without a drone lands the old flight and faces the spawn', () => {
    const next = createPlayerState({ x: 10, y: 0, z: 10 }, 1);
    next.view.yaw = 1.5;
    next.view.pitch = 0;
    const { game, calls } = respawnInto(next, true);
    expect(game.player.drone).toBeNull();
    expect(game.tactical.drone).toBeNull();
    expect(calls).toContain('stop');
    expect(game.input).toEqual({ yaw: 1.5, pitch: 0 });
    expect(game.savedView).toBeNull();
  });
});
