import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client } from '@colyseus/core';
import { initPhysics, type DropGunMessage } from '@wd/shared';
import { MatchSim } from '../match/MatchSim.ts';
import { MatchRoom } from './MatchRoom.ts';

beforeAll(async () => {
  await initPhysics();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function roomStub(): Promise<{
  room: MatchRoom;
  handlers: Map<string, (client: Client, msg: unknown) => void>;
}> {
  const room = new MatchRoom();
  const handlers = new Map<string, (client: Client, msg: unknown) => void>();
  let metadata: unknown;
  Object.defineProperty(room, 'metadata', {
    get: () => metadata,
    set: (value: unknown) => {
      metadata = value;
    },
    configurable: true,
  });
  vi.spyOn(room, 'onMessage').mockImplementation((type, _schema, cb) => {
    handlers.set(String(type), (client, msg) => cb(client, msg, {} as Parameters<typeof cb>[2]));
    return () => undefined;
  });
  vi.spyOn(room, 'setPrivate').mockResolvedValue(undefined);
  vi.spyOn(room.clock, 'setInterval').mockImplementation(
    () => undefined as unknown as ReturnType<typeof room.clock.setInterval>,
  );
  await room.onCreate({ lobby: true, map: 'range', size: 'full', mode: 'standard', botCount: 0 });
  return { room, handlers };
}

describe('match room development drop command', () => {
  it('registers no drop spawn command on a production server', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { room, handlers } = await roomStub();
    try {
      expect(handlers.has('dropGun')).toBe(false);
    } finally {
      room.onDispose();
    }
  });

  it('requires a real match player and disconnects malformed development payloads', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { room, handlers } = await roomStub();
    const sim = new MatchSim({ map: 'range', size: 'full', mode: 'standard', vehicles: 'off' });
    (room as unknown as { sim: MatchSim }).sim = sim;
    const leave = vi.fn();
    const client = { sessionId: 'a', leave } as unknown as Client;
    const drop = handlers.get('dropGun')!;
    const msg: DropGunMessage = { primaryId: 'shotgun', x: 0, z: -22, ammoFraction: 0.5 };
    try {
      drop(client, msg);
      expect(sim.drops).toHaveLength(0);
      sim.addPlayer('a', 'A', 0);
      drop(client, msg);
      expect(sim.drops).toHaveLength(1);
      // Invalid wire payloads arrive as null after DropGunMessageOrNull validation.
      drop(client, null);
      expect(leave).toHaveBeenCalledOnce();
      expect(sim.drops).toHaveLength(1);
    } finally {
      room.onDispose();
    }
  });
});
