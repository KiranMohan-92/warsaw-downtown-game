import { initPhysics, NET } from '@wd/shared';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './app.ts';
import { prewarmMatchMaps } from './match/MatchSim.ts';
import { trustCloudflare } from './rooms/matchGuard.ts';

// GAME_PORT, not PORT: tooling (preview launchers, some PaaS dev shells) sets PORT for the web client.
const port = Number.parseInt(process.env.GAME_PORT ?? '', 10) || NET.devServerPort;
// GAME_HOST: the listen address. 0.0.0.0 (default) for containers/platform routing; `pnpm host`
// binds 127.0.0.1 so only the local cloudflared can reach it (what makes WD_TRUST_CF safe).
const host = process.env.GAME_HOST?.trim() || '0.0.0.0';
const staticClientDir =
  process.env.NODE_ENV === 'production'
    ? fileURLToPath(new URL('../../client/dist/', import.meta.url))
    : undefined;

async function start(): Promise<void> {
  // Fail at startup if the combined production build was not copied in full.
  if (staticClientDir) await access(`${staticClientDir}/index.html`);
  // Bot nav graphs for every map before the first match (no mid-match build stalls).
  await initPhysics();
  const t0 = performance.now();
  prewarmMatchMaps();
  console.log(`[server] maps + bot nav prewarmed in ${Math.round(performance.now() - t0)} ms`);
  if (process.env.WD_TRUST_CF === '1') {
    console.log(
      trustCloudflare()
        ? '[server] rate limit keyed by CF-Connecting-IP (bound to loopback, behind the local tunnel)'
        : `[server] WD_TRUST_CF=1 ignored: GAME_HOST=${host} is not loopback, so the header could be forged`,
    );
  }
  await createGameServer(staticClientDir).listen(port, host);
  console.log(`[server] listening on ${host}:${port}${staticClientDir ? ' (client + game)' : ''}`);
}

void start().catch((error: unknown) => {
  console.error('[server] startup failed', error);
  process.exitCode = 1;
});
