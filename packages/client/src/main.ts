import type { PrimaryId, SurfaceKind, Vec3 } from '@wd/shared';
import { Game } from './game/Game.ts';
import { attachLoadingScreen } from './loading/LoadingScreen.ts';
import { resolveTips, rotateTips } from './loading/tips.ts';
import { connectDev, type NetStatus } from './net/devConnection.ts';
import {
  friendLobbyMode,
  friendSettingsFromGameSettings,
  runFriendLobby,
} from './net/friendLobby.ts';
import { launchPractice, practiceRequested } from './net/practiceRoom.ts';
import { keyLabel, loadSettings, type Action } from './settings/settings.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const params = new URLSearchParams(location.search);
const autotest = params.has('autotest');
const initialSettings = loadSettings();

// The static loading screen (index.html) shows real boot progress from here until warm-up ends.
const tips = resolveTips((action) => {
  const keys = initialSettings.keybinds[action as Action] as [string, string] | undefined;
  const code = keys?.[0] || keys?.[1];
  return code ? keyLabel(code) : null;
});
const loading = attachLoadingScreen({
  // A different first tip each load; the list then rotates in order.
  tips: rotateTips(tips, Math.random() * tips.length),
  // The menu under the screen takes no keyboard focus until the game is ready.
  under: hud,
  // The backdrop plays stills of the saved weather first.
  weather: initialSettings.weather,
});

let game: Game;
try {
  const lobby = !autotest && friendLobbyMode(location.search);
  // The friend lobby is its own screen (waiting on players there is not loading).
  if (lobby) loading?.pause();
  const friendLaunch = lobby
    ? await runFriendLobby({
        parent: hud,
        search: location.search,
        href: location.href,
        page: window.location,
        envUrl: import.meta.env.VITE_SERVER_URL as string | undefined,
        prod: import.meta.env.PROD,
        name: initialSettings.playerName,
        primary: initialSettings.primary,
        settings: friendSettingsFromGameSettings(initialSettings),
        chatMode: initialSettings.chatMode,
      })
    : null;
  if (lobby) loading?.resume();

  if (lobby && !friendLaunch) {
    throw new Error('friend lobby did not start');
  }
  // Practice vs bots (`?practice`, Menu › Practice vs bots): the server's match and bots in a
  // worker, played like a friend room that has already started.
  const practiceLaunch =
    !lobby && practiceRequested(location.search)
      ? launchPractice(initialSettings, undefined, location.search)
      : null;
  const launch = friendLaunch ?? practiceLaunch;

  const gameOptions = {
    autotest,
    governor: params.has('governor'),
    ...(loading ? { boot: loading } : {}),
    ...(launch
      ? {
          friendRoom: launch.room,
          friendSettings: launch.settings,
          friendBuffer: launch.buffer,
          friendName: launch.playerName,
          practice: launch === practiceLaunch,
        }
      : {}),
  };
  game = await Game.create(canvas, hud, gameOptions);
} catch (error) {
  // Boot failed: say so on the loading screen (with Reload) rather than freeze on it.
  loading?.fail(error);
  throw error;
}
game.start();
// Warm-up is done (Game.create awaited it): the screen fades out and stops catching input at
// once; under autotest it leaves the DOM right now, before `__wd.ready` below.
loading?.finish(autotest);

if (autotest) {
  // Scripted control surface for Playwright (see e2e/m1.spec.ts). Never enabled in normal play.
  Object.assign(window, {
    __wd: {
      ready: true,
      state: () => game.snapshot(),
      dummies: () => game.dummies.map((d) => ({ id: d.def.id, health: d.health, pos: d.pos })),
      /** Press for exactly one sim step, never lost to a slow frame (like a real key tap). */
      /** Start audio as a click would (decodes the CC0 clips). */
      unlockAudio: () => game.audio.unlock(),
      audioClips: () => game.audio.loadedClips,
      audioState: () => game.audio.state,
      samplesPlayed: () => game.audio.samplesPlayed,
      recentSamples: () => [...game.audio.recentSamples],
      /** Unlock audio from the next real (trusted) click, as the Play button does. */
      unlockAudioOnClick: () =>
        window.addEventListener('pointerdown', () => game.audio.unlock(), { once: true }),
      tap: (buttons: number) => {
        game.input.scriptedTaps |= buttons;
      },
      hold: (buttons: number, moveX = 0, moveZ = 0) => {
        game.input.scripted = { buttons, moveX, moveZ };
      },
      look: (yaw: number, pitch: number) => {
        game.input.yaw = yaw;
        game.input.pitch = pitch;
      },
      teleport: (x: number, y: number, z: number, yaw?: number, pitch?: number) =>
        game.teleport(x, y, z, yaw, pitch),
      /**
       * Cinematic camera moments on demand, for screenshots: 'intro' | 'death' | 'victory' |
       * 'off' (enables the moments on this autotest page; `state().camera` reports the shot).
       */
      cam: (kind: 'intro' | 'death' | 'victory' | 'off') => game.cam(kind),
      sceneStats: () => game.sceneStats(),
      gunLoadStats: () => game.gunLoadStats,
      drops: () => game.drops(),
      /** Server-authoritative in practice/online (development server only); local offline. */
      dropGun: (primaryId: PrimaryId, x: number, z: number, ammoFraction: number) =>
        game.dropGun(primaryId, x, z, ammoFraction),
      /** Our truck seat (null on foot) and the trucks as drawn. */
      vehicles: () => game.vehicleDebug(),
      /**
       * Spawn a bullet impact (flash, sparks, kick, dust, decal) on a surface, for screenshots:
       * `impact({ x, y, z }, { x: 0, y: 0, z: 1 }, 'metal')` (stone, metal, wood, glass, soft).
       */
      impact: (point: Vec3, normal: Vec3, surface: SurfaceKind = 'stone') =>
        game.debugImpact(point, normal, surface),
      /**
       * Presentation-only ghost truck for grading tyre dust + skid marks, on any page (offline
       * too): `tyreDemo('front')` crosses the view left to right from ~14 m ahead / ~10 m left,
       * drifting near the middle; `tyreDemo(x, z, yaw)` launches 2.5 s from a spot. Script:
       * launch, handbrake drift 1.5 s, straighten 0.8 s, hard brake 1.2 s, gone 2 s later.
       */
      tyreDemo: (x: number | 'front' = 'front', z = 0, yaw = 0) => game.tyreDemo(x, z, yaw),
      /** The ghost's phase, time, speed, position and whether it got blocked (null: none yet). */
      tyreDemoState: () => game.tyreDemoState(),
      /** Show (or hide) the hold-Tab scoreboard without a key (screenshots). */
      scoreboard: (on = true) => {
        game.scoreboardForced = on;
      },
      /** Perf bisection: hide meshes whose name starts with `prefix` (e.g. 'map:paving', 'trees'). */
      hide: (prefix: string, hidden = true) => game.hideMeshes(prefix, hidden),
    },
  });
}

if (import.meta.env.DEV) {
  // Dev-only handle for perf bisection scripts (tools/*probe*): never in production builds.
  (window as unknown as { __wdGame?: Game }).__wdGame = game;
  const { createTuningPanel } = await import('./debug/TuningPanel.ts');
  const panel = createTuningPanel();
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') panel.toggle();
  });
}

// M0 wiring check is local-development only; production uses the actual match connection.
if (import.meta.env.DEV) {
  const status = document.createElement('div');
  status.className = 'net-status';
  status.dataset.testid = 'net-status';
  hud.append(status);
  // Connect after the first frames: shader compilation on the first render can stall the page.
  const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
  await nextFrame();
  await nextFrame();
  void connectDev((s: NetStatus) => {
    status.textContent =
      s.state === 'connected'
        ? `server: connected (${s.rttMs.toFixed(0)} ms)`
        : s.state === 'connecting'
          ? 'server: connecting…'
          : `server: offline (${s.error})`;
  });
}
