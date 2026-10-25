# Hosting Warsaw Downtown

**Today's hosting (2026-09-30): this laptop + a Cloudflare quick tunnel, no account.** `pnpm host` builds the game, starts the production server on `:2600` and opens an anonymous `trycloudflare.com` HTTPS link, waits until `/health` answers through it, and prints the link. The link lives only while `pnpm host` runs and changes every start; the laptop must stay on and awake. Ctrl+C stops the server and the tunnel. Needs `cloudflared` (`$CLOUDFLARED`, `~/.local/bin/cloudflared.exe`, or on `PATH`; download from the cloudflared GitHub releases). Flags: `--no-build` (reuse the last build), `--port=N`.

To play with friends: open the link, press **Create friend room**, share the `…/?room=CODE` link it shows; everyone joins, only the host edits the settings and presses **Start match**. Opening the plain link is a quick match with bots. Verified 2026-09-30 through a public link with two browsers (host + friend in one room with 4 bots, 54 ms, no errors) and a 10-minute 6-client soak at 100 ms RTT (99.2 % hit confirm, 0 false hits). The per-address matchmaking limit (burst 12, 1/s) is keyed by Cloudflare's `CF-Connecting-IP` (the address Cloudflare saw; a client can forge the first `X-Forwarded-For` hop, which Colyseus would otherwise use), so a party behind one router shares one budget and cannot dodge it. **Invariant:** that header is trusted only because `pnpm host` binds the server to loopback (`GAME_HOST=127.0.0.1`) next to `WD_TRUST_CF=1`, so nothing but the local cloudflared can reach it. The server ignores `WD_TRUST_CF=1` (and logs it) with any other `GAME_HOST`; never set it on a server other machines can reach directly.

A permanent, always-on host (below) needs an account Kiran creates; nothing of that kind exists yet.

## Build and run

Use Node 22 or newer and the repository's pinned pnpm version. On an approved build machine with the locked dependencies installed:

```sh
pnpm build
NODE_ENV=production GAME_PORT=2567 pnpm start
```

`pnpm build` produces `packages/client/dist` (Vite) and `packages/server/dist/main.js` (tsup). The production server serves the client, `/health`, Colyseus matchmaking and WebSocket upgrades on the **same listener**. Production startup fails if the client index is missing. `GAME_PORT` is the listener port; `PORT` is deliberately ignored because preview tooling uses it for the client. Set `GAME_PORT` explicitly to the provider's target port. The listener binds to `GAME_HOST`, default `0.0.0.0` for container/platform routing (`pnpm host` uses `127.0.0.1`).

Open the public HTTPS URL and create a lobby, then share its `?room=CODE` link. `?online` remains quick join. The production client defaults to the page's origin; `?server=wss://game.example.com` is an explicit override for a separately hosted static client. In development Vite still connects to the game server on port 2567.

Static serving uses only Node APIs. `/` and `/index.html` serve the entry document, including query-only room links. Missing asset paths return 404, not an HTML fallback. Dotfiles, traversal and symlinks outside the built client directory are refused. Fingerprinted Vite assets are immutable for one year; HTML, public textures and manifests revalidate. Do not edit built files on a live server; build a new image and restart between games.

The Dockerfile builds using the existing lockfile, then copies only production dependencies and both build outputs into a non-root Node 22 image. It does not need Redis, a database, volumes or credentials. These commands are for a later approved environment; building the image downloads the Node image and locked packages:

```sh
docker build -t warsaw-downtown:local .
# On a VPS, expose the backend only to the local TLS proxy:
docker run --rm --name warsaw-downtown -p 127.0.0.1:2567:2567 warsaw-downtown:local
```

Use **one server process / one instance** for M3. Rooms, code lookup, bots and scores live in memory. Restarts and deploys lose them; reconnect seats only survive a connection drop while the same process lives. A second replica needs shared matchmaking/presence and routing work before it is supported. Start with one small instance near Warsaw, then measure memory and tick time with six players/bots; no instance size has been load-tested yet.

## Options for Kiran

| Option                                 | Cost shape                                                                | Fit and tradeoff                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render Web Service                     | Free instance available; paid compute removes free-instance restrictions. | Easiest short trial. Free services sleep after 15 minutes without incoming HTTP/WebSocket traffic, can restart, and have monthly usage limits. Treat a sleeping/restarted service as a lost room. [Free limits](https://render.com/docs/free), [WebSockets](https://render.com/docs/websocket).                                                     |
| Fly.io Machine                         | Usage billing after a limited trial; not a permanent free tier.           | Container workflow and regional placement. Its trial currently allows two VM hours or seven days, whichever first, with trial machines stopping after five minutes; unsuitable for an uninterrupted friends session without an approved paid budget. [Trial](https://docs.fly.io/about/free-trial/), [pricing](https://fly.io/docs/about/pricing/). |
| Small European VPS, e.g. Hetzner Cloud | Paid server plus any selected IP/backup/traffic charges.                  | Predictable single-machine deployment and direct control over the IP/TLS proxy. Requires OS updates, firewall and certificate maintenance. Prefer an EU location for this group. [Server overview](https://docs.hetzner.com/cloud/servers/overview/), [current plans](https://www.hetzner.com/cloud/).                                              |

Recommendation for review: Render Free for an initial short smoke test if its limits are acceptable; a small EU VPS for repeated scheduled sessions if Kiran accepts the monthly cost and maintenance. This is an operational judgment, not a measured capacity claim. Do not enable chargeable upgrades, add a payment method or provision resources without Kiran's approval.

### Render steps after approval

1. Create one **Web Service**, connect the approved repository/branch, choose the Docker runtime and an appropriate nearby region. A Static Site alone cannot run the authoritative match.
2. Set `NODE_ENV=production` and `GAME_PORT=10000` (Render's default target port); keep `/health` as the health-check path. The Docker command starts the game directly. Use one instance and disable automatic deploys if they could interrupt a session.
3. Confirm the proxy/IP requirements below before sharing the HTTPS service URL. Render forwards HTTP and WebSockets through one public port, terminates TLS and supports `wss` connections. [Service setup and ports](https://render.com/docs/web-services), [WebSocket behavior](https://render.com/docs/websocket).

### Fly.io steps after approval

1. Create an application using the Dockerfile in an EU region, then review the generated `fly.toml` before deploying. Configure `GAME_PORT=2567`, `http_service.internal_port=2567`, `force_https=true` and an HTTP `/health` check.
2. Deploy exactly one Machine (disable the default extra standby/redundant Machine). For scheduled games keep autostop disabled so the in-memory room remains alive. A trial's own runtime limit still applies. Review the resulting ongoing cost before leaving a Machine running. [Configuration reference](https://docs.fly.io/reference/configuration/).
3. Add a trusted proxy layer that overwrites `X-Real-IP` from Fly's authenticated `Fly-Client-IP` at ingress, or implement and review equivalent trusted-header normalization before public use. Fly documents that arbitrary `X-Forwarded-For` must be handled cautiously; this app does not yet consume `Fly-Client-IP` itself. [Fly request headers](https://docs.fly.io/networking/request-headers/).

### VPS steps after approval

1. Create one small EU Linux server with SSH-key access; review server, IPv4 and optional backup costs. Install Docker and a maintained TLS reverse proxy. Keep SSH restricted and only HTTP/HTTPS publicly reachable. [Hetzner server creation](https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/).
2. Build the image from the approved revision and run with the loopback-only mapping shown above; configure a restart policy/service for unattended operation. Point the approved domain to the machine and issue its TLS certificate.
3. Proxy the entire origin to `127.0.0.1:2567`, including matchmaking POSTs and WebSocket upgrades. Check `/health`, then run the manual session checklist below. Schedule future image replacement between games.

## HTTPS, WebSockets and client IPs

Public play requires a valid **HTTPS page and WSS socket**. TLS can terminate at the trusted proxy, with plain HTTP/WS only on the internal hop. Forward WebSocket upgrades and retain long-lived connections; do not put this stateful 60 Hz server in a short-lived request/serverless function. Split hosting must still use `wss://` for the game endpoint when the page is HTTPS. [Render's public WSS requirement](https://render.com/docs/websocket).

**M3a proxy contract:** matchmaking rate limits use Colyseus `AuthContext.ip`, which trusts the first `X-Real-IP` / `X-Forwarded-For` value. The edge must **overwrite `X-Real-IP` with a trusted client address and remove/overwrite untrusted forwarded address headers**, for both HTTP and upgrade requests. Never pass the user's header through unchanged or simply append it and then trust the first hop. Without trusted normalization, different users can share one rate key or forge a new key; the room cap is only a backstop. Keep the backend inaccessible except through that proxy. A provider's presence alone does not prove it overwrites these headers: verify the chain before publishing, and add an owned ingress proxy when necessary. Do not treat a room code as authentication or protection against public abuse.

For nginx directly facing clients on a VPS, put this location in an already configured HTTPS virtual host (certificate paths and HTTP-to-HTTPS redirect belong to that host):

```nginx
location / {
    proxy_pass http://127.0.0.1:2567;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

If another proxy/CDN is in front, `$remote_addr` is that proxy: configure its exact trusted address ranges and client-IP rules first. This snippet is for direct ingress, not a multi-proxy trust policy. The upgrade forwarding follows [nginx WebSocket documentation](https://nginx.org/en/docs/http/websocket.html).

## Verification before friends play

The WSL implementation pass used TypeScript and formatting checks plus non-listening static-handler assertions. Docker image build, native Vite/tsup build, public proxy behavior and browser multiplayer have not been run here. No port was opened and nothing was deployed.

On a supported, approved environment, run the full repository checks and build, then verify: `/health` returns OK; the HTTPS page and every asset load; two browsers join one room link; only the host edits/starts; bots leave room for late humans; six players stay within the cap; all clients show the same map/weather/radar/mode and results; a brief network interruption reconnects. Test a second real internet connection to confirm distinct trusted rate-limit addresses, and try forged forwarded headers to confirm they cannot change the rate key. Observe server memory and tick time for a full match. Keep browser performance and gameplay tuning as playtest gates.
