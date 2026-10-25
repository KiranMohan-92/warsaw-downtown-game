import { Client } from '@colyseus/sdk';
import { ROOMS, type PingMessage, type PongMessage } from '@wd/shared';
import { resolveServerUrl } from './connectOnline.ts';

export type NetStatus =
  | { state: 'connecting' }
  | { state: 'connected'; rttMs: number }
  | { state: 'offline'; error: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * M0 wiring: join the dev room and report RTT. Replaced by the match lobby in M3.
 * Retries with backoff: a join can fail if the page was busy (e.g. first-load shader compile)
 * when the seat reservation needed to be claimed.
 */
export async function connectDev(onStatus: (s: NetStatus) => void, attempts = 4): Promise<void> {
  // Same resolution as matches: in production the server is the page's own origin (https → wss).
  const url = resolveServerUrl(
    location.search,
    location,
    import.meta.env.VITE_SERVER_URL as string | undefined,
    import.meta.env.PROD,
  );
  onStatus({ state: 'connecting' });
  let lastError = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const room = await new Client(url).joinOrCreate(ROOMS.dev);
      room.onMessage('pong', (msg: PongMessage) => {
        onStatus({ state: 'connected', rttMs: performance.now() - msg.t });
      });
      const ping = (): void => {
        const msg: PingMessage = { t: performance.now() };
        room.send('ping', msg);
      };
      ping();
      const timer = setInterval(ping, 2000);
      room.onLeave(() => {
        clearInterval(timer);
        onStatus({ state: 'offline', error: 'disconnected' });
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(500 * 2 ** i);
    }
  }
  onStatus({ state: 'offline', error: lastError });
}
