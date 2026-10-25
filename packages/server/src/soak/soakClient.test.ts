import { describe, expect, it } from 'vitest';
import { seatToWire } from '@wd/shared';
import type { RemotePlayer } from '../../../client/src/net/onlineSession.ts';
import { remoteState } from './soakClient.ts';

describe('soak client: remote players as the bot brain sees them', () => {
  it('keeps a remote player’s seat (a visible driver is crew, not a foot target)', () => {
    const pose = { x: 1, y: 0, z: 2, eye: 1.05, yaw: 0, pitch: 0, hp: 100, f: 0 };
    const seated = {
      id: 'r',
      name: 'R',
      slot: 1,
      pose: { ...pose, vh: seatToWire({ vehicle: 2, seat: 'driver' }) },
    } as unknown as RemotePlayer;
    expect(remoteState(seated, 'ar7', 'standard').seat).toEqual({ vehicle: 2, seat: 'driver' });
    const onFoot = { id: 'r', name: 'R', slot: 1, pose } as unknown as RemotePlayer;
    expect(remoteState(onFoot, 'ar7', 'standard').seat).toBeNull();
  });
});
