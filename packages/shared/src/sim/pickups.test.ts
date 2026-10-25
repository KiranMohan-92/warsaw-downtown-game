import { describe, expect, it } from 'vitest';
import { RADAR } from '../config/tunables.ts';
import { Button } from './input.ts';
import {
  createPickups,
  createRadarState,
  grantRadarCharge,
  matchPickupDefs,
  radarFull,
  stepPickups,
  stepRadar,
} from './pickups.ts';

describe('radar uplinks', () => {
  const defs = [{ id: 'r1', pos: { x: 0, y: 0, z: 0 }, kind: 'radar' as const }];

  it('collected by walking onto it, then recharges', () => {
    const p = createPickups(defs);
    const far = [{ id: 'a', pos: { x: 5, y: 0, z: 0 }, alive: true }];
    expect(stepPickups(p, far, 0.1)).toEqual([]);
    const on = [{ id: 'a', pos: { x: 0.5, y: 0.02, z: 0.5 }, alive: true }];
    expect(stepPickups(p, on, 0.1)).toEqual([{ pickupId: 'r1', by: 'a', kind: 'radar' }]);
    expect(stepPickups(p, on, 0.1)).toEqual([]); // recharging
    for (let t = 0; t < RADAR.respawn; t += 1) stepPickups(p, [], 1);
    expect(stepPickups(p, on, 0.1).length).toBe(1);
  });

  it('the dead cannot collect, and a different floor does not count', () => {
    const p = createPickups(defs);
    expect(stepPickups(p, [{ id: 'd', pos: { x: 0, y: 0, z: 0 }, alive: false }], 0.1)).toEqual([]);
    expect(stepPickups(p, [{ id: 'u', pos: { x: 0, y: 3.6, z: 0 }, alive: true }], 0.1)).toEqual(
      [],
    );
  });

  it('the radar is dark until you call in a charge; calling spends it', () => {
    const r = createRadarState();
    expect(stepRadar(r, Button.Radar, 0, 0.016)).toBe(false); // nothing to call
    expect(r.live).toBe(0);
    grantRadarCharge(r);
    expect(radarFull(r)).toBe(true);
    expect(r.live).toBe(0); // collecting does not reveal anyone
    expect(stepRadar(r, Button.Radar, 0, 0.016)).toBe(true);
    expect(r.live).toBe(RADAR.duration);
    expect(r.charges).toBe(0);
    expect(stepRadar(r, Button.Radar, Button.Radar, 0.016)).toBe(false); // held, not re-pressed
  });

  it('a full player walks past an uplink without taking it', () => {
    const p = createPickups(defs);
    const on = [{ id: 'a', pos: { x: 0, y: 0, z: 0 }, alive: true, takes: () => false }];
    expect(stepPickups(p, on, 0.1)).toEqual([]);
    expect(p[0]!.cooldown).toBe(0);
  });
});

describe('match pickups', () => {
  const defs = [
    { id: 'r1', pos: { x: 0, y: 0, z: 0 }, kind: 'radar' as const },
    { id: 'd1', pos: { x: 1, y: 0, z: 0 }, kind: 'drone' as const },
    { id: 'm1', pos: { x: 2, y: 0, z: 0 }, kind: 'medkit' as const },
  ];

  it('medkits and recon uplinks always, radar uplinks unless radar is off', () => {
    expect(matchPickupDefs(defs, 'uplinks').map((d) => d.id)).toEqual(['r1', 'd1', 'm1']);
    expect(matchPickupDefs(defs, 'off').map((d) => d.id)).toEqual(['d1', 'm1']);
  });
});
