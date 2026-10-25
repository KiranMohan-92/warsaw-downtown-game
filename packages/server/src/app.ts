import { createEndpoint, createRouter, defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { MATCH_KEYS, QUICK_JOIN_SETTINGS, ROOMS, type QuickJoinSettings } from '@wd/shared';
import { DevRoom } from './rooms/DevRoom.ts';
import { MatchRoom } from './rooms/MatchRoom.ts';
import { staticClientResponse } from './staticClient.ts';

/**
 * Build the game server (not yet listening). Shared by `main.ts` and the integration tests.
 *
 * Explicit core + transport (not the `colyseus` meta-package): the meta-package's optional peers
 * made pnpm install two @colyseus/core copies, splitting the room registry between matchmaker
 * and transport so every join failed with "seat reservation expired". `app.test.ts` guards this.
 */
export function createGameServer(
  staticClientDir?: string,
  opts: { quickJoin?: Partial<QuickJoinSettings> } = {},
): ReturnType<typeof defineServer> {
  // Quick-join settings are the server's (tests run them without bots); never the client's.
  const quickJoin: QuickJoinSettings = { ...QUICK_JOIN_SETTINGS, ...opts.quickJoin };
  class ConfiguredMatchRoom extends MatchRoom {
    protected override quickJoinSettings(): QuickJoinSettings {
      return quickJoin;
    }
  }
  const healthRoutes = {
    health: createEndpoint('/health', { method: 'GET' }, () => Promise.resolve({ ok: true })),
  };
  const routes = staticClientDir
    ? createRouter({
        ...healthRoutes,
        clientIndex: createEndpoint('/', { method: ['GET', 'HEAD'], requireRequest: true }, (ctx) =>
          staticClientResponse(staticClientDir, ctx.request),
        ),
        clientAsset: createEndpoint(
          '/**',
          { method: ['GET', 'HEAD'], requireRequest: true },
          (ctx) => staticClientResponse(staticClientDir, ctx.request),
        ),
      })
    : createRouter(healthRoutes);
  return defineServer({
    transport: new WebSocketTransport(),
    greet: false,
    rooms: {
      [ROOMS.dev]: defineRoom(DevRoom),
      // Quick-join only matches other non-lobby rooms with the same starting map/size/mode
      // (`MatchRoom.onAuth` requires every key). Friend lobbies are private: joined by room id
      // from the share link only.
      [ROOMS.match]: defineRoom(ConfiguredMatchRoom).filterBy([...MATCH_KEYS]),
    },
    routes,
  });
}
