import { beforeAll, describe, expect, it } from 'vitest';
import { Button, emptyInput, initPhysics, snapshotAction, type SnapshotMessage } from '@wd/shared';
import { MatchSim, type QueuedInput } from './MatchSim.ts';

beforeAll(async () => {
  await initPhysics();
});

/** Input sequence numbers per player (kept across calls: the server drops repeats). */
const seq = new Map<string, number>();

/** One input per player per tick, then a server tick. */
function drive(
  sim: MatchSim,
  ticks: number,
  inputs: (i: number) => Record<string, Partial<QueuedInput>>,
): void {
  for (let i = 0; i < ticks; i++) {
    for (const [id, extra] of Object.entries(inputs(i))) {
      const s = seq.get(id) ?? 0;
      seq.set(id, s + 1);
      sim.receiveInputs(id, [{ ...emptyInput(s), ...extra, seq: s }], sim.nowMs);
    }
    sim.step();
    sim.drainEvents();
  }
}

const entry = (m: SnapshotMessage, id: string) => m.players.find((p) => p.id === id)!;

describe('snapshot actions (others see your hands)', () => {
  it("a player's reload and throw ride in everyone's snapshot, from the authoritative state", () => {
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard' });
    const a = sim.addPlayer('a', 'Ada', 0);
    sim.addPlayer('b', 'Bo', 0);
    a.state.guns.rifle.ammo = 5;
    drive(sim, 30, (i) => ({ a: i === 0 ? { buttons: Button.Reload } : {}, b: {} }));
    const seenByB = snapshotAction(entry(sim.snapshot('b'), 'a'));
    expect(seenByB.kind).toBe('reload');
    expect(seenByB.t).toBeGreaterThan(0.1);
    expect(seenByB.t).toBeLessThan(0.5);
    // The same code in a's own entry (one derivation for every recipient).
    expect(entry(sim.snapshot('a'), 'a').ac).toBe(entry(sim.snapshot('b'), 'a').ac);
    expect(entry(sim.snapshot('b'), 'b').ac).toBeUndefined(); // idle: nothing on the wire
    // Finish the reload, then throw: the throw shows, then clears.
    drive(sim, 200, () => ({ a: {}, b: {} }));
    expect(entry(sim.snapshot('b'), 'a').ac).toBeUndefined();
    drive(sim, 3, (i) => ({ a: i === 0 ? { buttons: Button.Grenade } : {}, b: {} }));
    expect(snapshotAction(entry(sim.snapshot('b'), 'a')).kind).toBe('throw');
    sim.dispose();
  });
});
