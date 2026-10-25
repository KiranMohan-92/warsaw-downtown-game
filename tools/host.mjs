// Host a game for friends from this machine — no account needed (Cloudflare quick tunnel).
//   pnpm host                 build, start the production server, open a public HTTPS link
//   pnpm host --no-build      reuse the last build
//   pnpm host --port=2600     local port (default 2600)
// Needs cloudflared: $CLOUDFLARED, ~/.local/bin/cloudflared(.exe), or on PATH.
// The link lives only while this runs (and changes every time). Ctrl+C stops the server and tunnel.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const PORT = Number(arg('port', 2600));
const win = process.platform === 'win32';

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED,
    join(homedir(), '.local', 'bin', win ? 'cloudflared.exe' : 'cloudflared'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync(win ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
  const hit = which.stdout?.split(/\r?\n/).find(Boolean);
  if (hit) return hit;
  console.error(
    'cloudflared not found. Download it from https://github.com/cloudflare/cloudflared/releases\n' +
      'and put it on PATH or at ~/.local/bin, or set CLOUDFLARED=<path>.',
  );
  process.exit(2);
}

async function health(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      // Bounded: a tunnel that connects but never answers must not stall the retry loop.
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const cloudflared = findCloudflared();
if (!process.argv.includes('--no-build')) {
  console.log('[host] building…');
  const b = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: win });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const serverMain = join(ROOT, 'packages', 'server', 'dist', 'main.js');
if (!existsSync(serverMain)) {
  console.error(`[host] no build at ${serverMain}: run without --no-build`);
  process.exit(2);
}

const children = [];
const stop = (code = 0) => {
  for (const c of children) c.kill();
  process.exit(code);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log(`[host] starting the game server on :${PORT}…`);
const server = spawn(process.execPath, [serverMain], {
  cwd: join(ROOT, 'packages', 'server'),
  // Bound to loopback (GAME_HOST): only the local cloudflared can reach the server, so it may key
  // the matchmaking rate limit by Cloudflare's CF-Connecting-IP (WD_TRUST_CF; a client can forge
  // the first X-Forwarded-For hop). The server ignores WD_TRUST_CF on any other bind address
  // (see matchGuard.trustCloudflare).
  env: {
    ...process.env,
    NODE_ENV: 'production',
    GAME_PORT: String(PORT),
    GAME_HOST: '127.0.0.1',
    WD_TRUST_CF: '1',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(server);
server.on('error', (e) => {
  console.error(`[host] could not start the game server: ${e.message}`);
  stop(1);
});
server.on('exit', (code) => {
  console.error(`[host] game server exited (${code}); stopping`);
  stop(code ?? 1);
});
if (!(await health(`http://127.0.0.1:${PORT}`))) {
  console.error('[host] the game server did not come up on /health');
  stop(1);
}

// Quick tunnels are ephemeral: once Cloudflare drops one ("Tunnel not found") it never comes
// back, so the tunnel is supervised — a dead or unreachable link is replaced by a new one (and a
// new link is printed; the server and its rooms keep running).
let tunnel = null;
let url = null;
let restarting = false;
const banner = (u, again) =>
  console.log(`
  ============================================================
   ${again ? 'NEW LINK (the old one stopped working)' : 'Warsaw Downtown is live'}:  ${u}

   Play with friends:
     1. Open the link, press "Create friend room" in the menu.
     2. Share the room link it shows (…/?room=CODE) with friends.
     3. Everyone joins; you (the host) pick the settings and Start.
   Quick match with bots: just open ${u}

   Keep this window open and the laptop awake. Ctrl+C stops hosting.
  ============================================================
`);
// cloudflared reads ~/.cloudflared/config.y(a)ml by default, and its ingress rules win over
// --url: a user's existing tunnel config could publish another service instead of the game.
// Point it at our own minimal config (never touching theirs).
const tunnelConfig = join(tmpdir(), 'warsaw-downtown-quick-tunnel.yml');
writeFileSync(
  tunnelConfig,
  '# Warsaw Downtown quick tunnel: no ingress rules, --url decides.\nno-autoupdate: true\n',
);
async function openTunnel(again) {
  console.log('[host] opening a Cloudflare quick tunnel…');
  url = null; // the watchdog only checks a link that answered
  const t = spawn(
    cloudflared,
    ['tunnel', '--config', tunnelConfig, '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  tunnel = t;
  children.push(t);
  let live = false;
  // Settles with the link, or null if cloudflared dies (or fails to spawn) before printing one.
  const found = new Promise((resolve) => {
    t.once('exit', () => resolve(null));
    t.once('error', () => resolve(null));
    // Per stream, scan complete lines only (a log line can arrive split across two chunks).
    const scanner = () => {
      let pending = '';
      return (buf) => {
        pending += String(buf);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        if (pending.length > 4096) pending = pending.slice(-4096);
        for (const text of lines) {
          const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
          if (m) resolve(m[0]);
          if (
            /Tunnel not found|failed to request quick Tunnel/i.test(text) &&
            live &&
            tunnel === t
          ) {
            console.error('[host] Cloudflare dropped the tunnel; opening a new one');
            void replaceTunnel();
          }
        }
      };
    };
    t.stdout.on('data', scanner());
    t.stderr.on('data', scanner());
  });
  t.on('error', (e) => {
    console.error(`[host] could not start cloudflared (${cloudflared}): ${e.message}`);
    stop(1);
  });
  t.on('exit', (code) => {
    if (tunnel === t && !restarting) {
      console.error(`[host] tunnel exited (${code}); opening a new one`);
      void replaceTunnel();
    }
  });
  const link = await found;
  // Died before printing a link: its exit handler is already opening the next one.
  if (!link || tunnel !== t) return;
  const ok = await health(link, 90);
  if (tunnel !== t) return; // replaced while we waited (it exited): not ours to announce or retry
  if (ok) {
    live = true;
    url = link;
    banner(link, again);
  } else {
    console.error(`[host] ${link} never answered /health; trying a new tunnel`);
    void replaceTunnel();
  }
}
async function replaceTunnel() {
  if (restarting) return;
  restarting = true;
  url = null;
  misses = 0;
  const old = tunnel;
  tunnel = null;
  old?.kill();
  await new Promise((r) => setTimeout(r, 3000));
  restarting = false;
  await openTunnel(true);
}
// Watchdog (installed before the first tunnel, independent of it ever answering): three failed
// public health checks in a row (3 min) → a new tunnel.
let misses = 0;
setInterval(async () => {
  if (!url || restarting) return;
  const checked = url;
  try {
    const r = await fetch(`${checked}/health`, { signal: AbortSignal.timeout(10_000) });
    misses = r.ok ? 0 : misses + 1;
  } catch {
    misses++;
  }
  if (misses >= 3 && url === checked) {
    misses = 0;
    console.error(`[host] ${checked} stopped answering; opening a new tunnel`);
    void replaceTunnel();
  }
}, 60_000);
void openTunnel(false);
