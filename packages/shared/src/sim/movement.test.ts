import { describe, expect, it } from 'vitest';
import { MOVEMENT, PLAYER, SIM_DT } from '../config/tunables.ts';
import { Button } from './input.ts';
import { createPlayerState, horizontalSpeed } from './player.ts';
import { FlatGroundBody, run } from './testUtils.ts';

const fresh = (): { p: ReturnType<typeof createPlayerState>; body: FlatGroundBody } => {
  const p = createPlayerState({ x: 0, y: 0, z: 0 });
  const body = new FlatGroundBody();
  run(p, body, 0.1, {}); // settle: become grounded
  return { p, body };
};

describe('movement', () => {
  it('settles onto the ground', () => {
    const { p } = fresh();
    expect(p.move.grounded).toBe(true);
    expect(p.move.vel.y).toBe(0);
  });

  it('reaches walk speed, not faster, with acceleration (not instantly)', () => {
    const { p, body } = fresh();
    run(p, body, SIM_DT, { moveZ: 1 });
    expect(horizontalSpeed(p.move)).toBeLessThan(MOVEMENT.walkSpeed);
    run(p, body, 1, { moveZ: 1 });
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.walkSpeed, 5);
  });

  it('yaw 0 + forward moves toward -Z', () => {
    const { p, body } = fresh();
    run(p, body, 0.5, { moveZ: 1, yaw: 0 });
    expect(p.move.pos.z).toBeLessThan(-0.5);
    expect(Math.abs(p.move.pos.x)).toBeLessThan(1e-9);
  });

  it('caps each stance at its tuned speed', () => {
    const cases: [number, number][] = [
      [Button.Sprint, MOVEMENT.sprintSpeed],
      [Button.Crouch, MOVEMENT.crouchSpeed],
      [Button.Crouch | Button.Sprint, MOVEMENT.lowRunSpeed], // low run: bent-over sprint
      [Button.Ads, MOVEMENT.walkSpeed * MOVEMENT.adsSpeedMultiplier],
    ];
    for (const [buttons, expected] of cases) {
      const { p, body } = fresh();
      run(p, body, 1.5, { moveZ: 1, buttons });
      expect(horizontalSpeed(p.move)).toBeCloseTo(expected, 4);
    }
  });

  it('low run (Sprint + Crouch on the move): lower eye, capsule standing, quiet steps', () => {
    const { p, body } = fresh();
    const steps: { sprint: boolean; crouch: boolean }[] = [];
    run(p, body, 1.5, { moveZ: 1, buttons: Button.Sprint | Button.Crouch }, (e) => {
      for (const x of e) if (x.type === 'footstep') steps.push(x);
    });
    expect(p.move.lowRun).toBe(true);
    expect(p.move.sprinting).toBe(true);
    expect(p.move.crouched).toBe(false);
    expect(p.move.eyeHeight).toBeCloseTo(PLAYER.lowRunEyeHeight, 5);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((x) => x.crouch && !x.sprint)).toBe(true);
    // Let go of crouch: straight into a full sprint.
    run(p, body, 1.5, { moveZ: 1, buttons: Button.Sprint });
    expect(p.move.lowRun).toBe(false);
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.sprintSpeed, 4);
    expect(p.move.eyeHeight).toBeCloseTo(PLAYER.standEyeHeight, 5);
  });

  it('Sprint + Crouch standing still just crouches', () => {
    const { p, body } = fresh();
    run(p, body, 0.5, { buttons: Button.Sprint | Button.Crouch });
    expect(p.move.crouched).toBe(true);
    expect(p.move.lowRun).toBe(false);
  });

  it('cannot sprint backwards or sideways', () => {
    const { p, body } = fresh();
    run(p, body, 1.5, { moveX: 1, buttons: Button.Sprint });
    expect(p.move.sprinting).toBe(false);
    expect(horizontalSpeed(p.move)).toBeCloseTo(MOVEMENT.walkSpeed, 4);
  });

  it('firing cancels sprint', () => {
    const { p, body } = fresh();
    run(p, body, 1, { moveZ: 1, buttons: Button.Sprint });
    expect(p.move.sprinting).toBe(true);
    run(p, body, SIM_DT, { moveZ: 1, buttons: Button.Sprint | Button.Fire });
    expect(p.move.sprinting).toBe(false);
  });

  it('decelerates to a stop in a predictable distance', () => {
    const { p, body } = fresh();
    run(p, body, 1, { moveZ: 1 });
    const z0 = p.move.pos.z;
    run(p, body, 1, {});
    expect(horizontalSpeed(p.move)).toBe(0);
    const stop = Math.abs(p.move.pos.z - z0);
    const ideal = MOVEMENT.walkSpeed ** 2 / (2 * MOVEMENT.groundDeceleration);
    expect(stop).toBeGreaterThan(ideal * 0.8);
    expect(stop).toBeLessThan(ideal * 1.3);
  });

  it('jump apex matches the tuned jump height', () => {
    const { p, body } = fresh();
    let apex = 0;
    run(
      p,
      body,
      1.2,
      (i) => ({ buttons: i === 0 ? Button.Jump : 0 }),
      () => {
        apex = Math.max(apex, p.move.pos.y);
      },
    );
    expect(apex).toBeGreaterThan(MOVEMENT.jumpHeight * 0.95);
    expect(apex).toBeLessThan(MOVEMENT.jumpHeight * 1.05);
    expect(p.move.grounded).toBe(true);
  });

  it('holding jump does not bunny-hop; a new press is needed', () => {
    const { p, body } = fresh();
    const events = run(p, body, 2, { buttons: Button.Jump });
    expect(events.filter((e) => e.type === 'jump')).toHaveLength(1);
  });

  it('jump buffered just before landing fires on landing', () => {
    const { p, body } = fresh();
    run(p, body, SIM_DT, { buttons: Button.Jump });
    // Wait until falling close to the ground, then tap jump once while still airborne.
    let jumps = 0;
    let tapped = false;
    run(
      p,
      body,
      1.5,
      () => {
        const nearGround = !tapped && p.move.vel.y < 0 && p.move.pos.y > 0 && p.move.pos.y < 0.2;
        if (nearGround) tapped = true;
        return { buttons: nearGround ? Button.Jump : 0 };
      },
      (ev) => {
        jumps += ev.filter((e) => e.type === 'jump').length;
      },
    );
    expect(jumps).toBe(1);
  });

  it('crouch lowers the eye height smoothly', () => {
    const { p, body } = fresh();
    run(p, body, SIM_DT, { buttons: Button.Crouch });
    expect(p.move.crouched).toBe(true);
    expect(p.move.eyeHeight).toBeGreaterThan(PLAYER.crouchEyeHeight);
    run(p, body, 0.5, { buttons: Button.Crouch });
    expect(p.move.eyeHeight).toBeCloseTo(PLAYER.crouchEyeHeight, 6);
  });

  it('emits footsteps while moving, faster when sprinting', () => {
    const walk = fresh();
    const walkSteps = run(walk.p, walk.body, 3, { moveZ: 1 }).filter((e) => e.type === 'footstep');
    const sprint = fresh();
    const sprintSteps = run(sprint.p, sprint.body, 3, { moveZ: 1, buttons: Button.Sprint }).filter(
      (e) => e.type === 'footstep',
    );
    expect(walkSteps.length).toBeGreaterThan(4);
    expect(sprintSteps.length).toBeGreaterThan(walkSteps.length);
  });
});
