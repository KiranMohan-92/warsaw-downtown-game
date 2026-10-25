/**
 * THE single balance/config module. Every gameplay number lives here so balance can be tweaked
 * without reading game code. Units: metres, seconds, degrees, HP unless noted.
 *
 * Objects are intentionally mutable: the dev-only tuning panel (backtick key in the client)
 * edits them live. Server and tests always use these defaults.
 */
import type { PropModelId } from '../maps/propModels.ts';

export const NET = {
  /** Server snapshot / patch rate (Hz). */
  serverTickHz: 30,
  /** Default port for the game server in local dev. */
  devServerPort: 2567,
};

export const SIM = {
  /** Fixed simulation step rate (Hz), identical on client and server. */
  tickHz: 60,
  /** Max sim steps per rendered frame before the client drops time (spiral-of-death guard). */
  maxStepsPerFrame: 5,
};

export const SIM_DT = 1 / SIM.tickHz;

export const PLAYER = {
  maxHealth: 100,
  /** Capsule radius. */
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.2,
  /** Camera height above feet. */
  standEyeHeight: 1.62,
  crouchEyeHeight: 1.05,
  /** Eye height in a low run (hitboxes scale with it: a smaller target than a full sprint). */
  lowRunEyeHeight: 1.3,
  /** Eye height change speed (m/s) when crouching/standing, purely positional smoothing. */
  eyeHeightSpeed: 5,
  /** Prone (Kiran: shoot lying on your stomach): capsule height and eye height (m). */
  proneHeight: 0.75,
  proneEyeHeight: 0.35,
  /** Getting down / up is slower than a crouch (≈ 0.6 s from standing). */
  proneEyeSpeed: 2.2,
  /** Below this eye height the hit volumes lie along the ground (prone). */
  proneHitboxEye: 0.6,
};

/** Prone: slow crawl, steadier aim. */
export const PRONE = {
  crawlSpeed: 1.1,
  /** Hip spread and recoil multipliers while prone (ADS already steady). */
  spreadMultiplier: 0.5,
  recoilMultiplier: 0.6,
  /** Going prone needs this much clear ground behind the head (the body lies there) (m). */
  bodyLength: 1.7,
};

/**
 * Slide (Kiran, 2026-09-28: "fast and fluid"): Crouch pressed while sprinting on the ground
 * (`sim/movement.ts` `canSlide` / `slideVelocity`). A committed burst: launch, constant friction,
 * weak steering; the capsule is the crouch one; Jump cancels it into a normal jump.
 */
export const SLIDE = {
  /** Needs at least this horizontal speed to start (m/s; walk 4.6, low run 5.8, sprint 6.9). */
  minSpeed: 5.5,
  /**
   * Launch speed = entry speed × this, the entry capped at sprint speed × the held weapon's
   * mobility (a knife lunge or a vault carry can't be stacked into it): 6.9 → 8.97 m/s.
   */
  boost: 1.3,
  /** Slide friction (m/s², constant): 8.97 → 2.3 m/s (crouch walk, where it ends) in ≈ 0.74 s. */
  friction: 9,
  /**
   * Slopes: friction += gravity × this × rise-over-run of the step (clamped ±0.5), so uphill
   * ends it sooner and downhill carries it on (never faster: at the clamp 22 × 0.8 × 0.5 < 9).
   */
  slopeFactor: 0.8,
  /** Hard cap on one slide (s): a long downhill still ends. */
  maxTime: 1.1,
  /** Steering: the slide turns toward the stick direction at most this fast (rad/s, ≈ 30° a slide). */
  steerRate: 0.7,
  /** A step that moved less than this fraction of its intended distance hit a wall: slide over. */
  wallStop: 0.5,
  /** The next slide can start no sooner than this after one ends (s): no chaining. */
  cooldown: 0.8,
  /** A Crouch press this long before touching down from a sprint jump slides on landing (s). */
  landBuffer: 0.15,
  /** Camera height while sliding (m; crouch 1.05) and how fast it drops there (m/s). */
  eyeHeight: 0.95,
  eyeSpeed: 8,
  /** Hip spread = crouch-walking spread × this (fully aimed: unaffected). */
  spreadMultiplier: 1.2,
  /** Aiming down sights takes this much longer while sliding. */
  adsTimeMultiplier: 1.6,
};

/**
 * Tactical sprint: a short burst faster than a sprint, weapon held low (no firing or aiming),
 * from a sprint by double-tapping Sprint (or pressing it again while sprinting with toggle
 * sprint) — the client turns that gesture into `Button.TacSprint`; the rules live here and in
 * `sim/movement.ts`, so prediction and server agree. A "tank" drains while bursting and refills
 * after a pause; empty, the burst drops back into a normal sprint. Tuned for close quarters
 * (Market): a burst covers ~16 m, enough to cross a lane, and the gun takes almost twice the
 * usual sprint-out to come up, so bursting round a corner into someone aiming at it loses.
 */
export const TAC_SPRINT = {
  /** Top speed (m/s; sprint 6.9, ≈ +20 %), × the held weapon's mobility like every speed. */
  speed: 8.3,
  /** A full tank lasts this long (s). */
  duration: 2,
  /** A burst needs at least this much in the tank to start (0–1): ≥ 1 s, no stutter-spam. */
  minStart: 0.5,
  /** The tank starts refilling this long after a burst ends (s)… */
  rechargeDelay: 1,
  /** …and refills from empty in this long (s). */
  rechargeTime: 4,
  /** Sprint-out after a burst = the gun's `sprintToFireTime` × this (AR-7: 0.18 → 0.34 s). */
  sprintOutMultiplier: 1.9,
  /** Two Sprint presses within this long make a double tap (client input, s). */
  doubleTapWindow: 0.3,
};

/** How a bot fights with one gun (`BOT.weapons`). */
export interface BotGunProfile {
  engageRange: number;
  closeRange: number;
  fireRange: number;
  plant: boolean;
}

/** Server-side M3 bots. They still drive only PlayerInput; these tune their senses and hands. */
export const BOT = {
  sightRange: 85,
  /** Full camera cone. Shared sightVisibility still applies walls, smoke and foliage. */
  sightFovDeg: 100,
  memorySeconds: 8,
  /**
   * How bots fight with each gun (m): close in on a target farther than `closeRange`, hold at
   * about `engageRange`, and never fire past `fireRange` (pellets/falloff make it pointless).
   * `plant`: stand still (no strafe) to shoot — guns whose moving spread wastes every shot.
   */
  weapons: {
    ar7: { engageRange: 8, closeRange: 16, fireRange: 85, plant: false },
    coil: { engageRange: 14, closeRange: 30, fireRange: 85, plant: true },
    iskra: { engageRange: 7, closeRange: 14, fireRange: 40, plant: false },
    shotgun: { engageRange: 6, closeRange: 10, fireRange: 16, plant: false },
    marksman: { engageRange: 16, closeRange: 32, fireRange: 85, plant: true },
    arc: { engageRange: 9, closeRange: 18, fireRange: 60, plant: false },
  } satisfies Record<PrimaryId, BotGunProfile>,
  /** The P-9, once the primary is dry. */
  sidearm: { engageRange: 7, closeRange: 14, fireRange: 40, plant: false } as BotGunProfile,
  /** Scoped guns (marksman, coilgun) fire only once aimed in this far (0–1): hip shots are wild. */
  scopedFireAds: 0.9,
  /** Energy guns: stop firing at this heat and wait until it cools below `heatResume` (no lockout). */
  heatRelease: 0.85,
  heatResume: 0.35,
  /** Full-auto guns fire in bursts (s pause after `burstRounds`) so the recoil settles. */
  burstRounds: 5,
  burstPause: 0.35,
  /**
   * Primaries a bot may draw for a life (seeded per bot and life, through the normal loadout
   * path). All six: the behaviour tree handles charge (coil), heat (arc), range (shotgun) and scope.
   */
  primaries: ['ar7', 'coil', 'iskra', 'shotgun', 'marksman', 'arc'] as readonly PrimaryId[],
  lowHealthCover: 0.35,
  /** Target-choice score added for a spawn-protected player (m-equivalent): anyone else first. */
  protectedPenalty: 1000,
  lowAmmoReload: 2,
  coverSearchRadius: 14,
  grenadeCooldownMin: 9,
  grenadeCooldownJitter: 6,
  wanderMinSeconds: 3,
  wanderJitterSeconds: 2.5,
  navCellSize: 2,
  navGroundRayStart: 4.5,
  navGroundRayDistance: 8,
  stuckWindowSeconds: 0.9,
  stuckMinProgress: 0.25,
  unstickSeconds: 0.45,
  /**
   * Bots shoot once their crosshair (recoil kick included) is within this many torso half-widths
   * of their aim point, like a player waiting for the sights to be on the body — or within
   * `fireToleranceMinDeg` at range (a player takes the shot rather than wait for a perfect one).
   */
  fireTolerance: 1.5,
  fireToleranceMinDeg: 0.9,
  /**
   * Per difficulty, tuned by measurement against an average-human reference player
   * (`pnpm bots:measure`, `server/src/bots/measure/`): duel win rate, reaction, headshot share.
   * - `reactionMs`: sight → acquired (the view starts turning only then; ×0.75–1.25), and the
   *   interval the steady aim error is redrawn at (×0.65–1.35).
   * - `turnRate`: view turn cap (rad/s). `aimError`: steady aim wobble (rad, full width).
   * - `settleError` / `settleMs`: the first aim at a newly acquired target is off by about
   *   `settleError` rad, settling exponentially with time constant `settleMs` (no snap-aim).
   * - `trackLagMs`: the aim follows a moving target where it was this long ago.
   * - `headAimChance`: share of engagements aimed at the head (else centre mass).
   * - `recoilControl`: fraction of the visible recoil kick pulled back down.
   * - `fireChance`: chance each round's trigger pull happens; `strafeChance`: strafe in fights.
   */
  difficulty: {
    easy: {
      reactionMs: 320,
      turnRate: 2.6,
      aimError: 0.04,
      settleError: 0.05,
      settleMs: 200,
      trackLagMs: 200,
      headAimChance: 0.03,
      recoilControl: 0.3,
      fireChance: 0.7,
      strafeChance: 0.35,
    },
    normal: {
      reactionMs: 170,
      turnRate: 4.2,
      aimError: 0.034,
      settleError: 0.04,
      settleMs: 100,
      trackLagMs: 140,
      headAimChance: 0.1,
      recoilControl: 0.4,
      fireChance: 0.8,
      strafeChance: 0.55,
    },
    hard: {
      reactionMs: 110,
      turnRate: 6.5,
      aimError: 0.022,
      settleError: 0.03,
      settleMs: 80,
      trackLagMs: 110,
      headAimChance: 0.2,
      recoilControl: 0.6,
      fireChance: 0.92,
      strafeChance: 0.72,
    },
  },
  /**
   * Bot personalities (how a bot plays, never how well it aims: that is the difficulty above,
   * measured with every personality in the mix). Seats cycle through `personalityOrder`.
   * - `callsigns`: roster names (seat order); `primaries`: the guns it draws per life.
   * - `rangeScale`: × the gun's engage/close ranges (rusher pushes in, marksman holds off).
   * - `strafeScale`: × the difficulty's strafe chance in fights (capped at 0.95).
   * - `coverHealth`: health share below which it breaks off to cover.
   * - `crouchFire`: share of engagements it crouches to shoot (steadier, smaller).
   * - `tacSprint`: tactical-sprint bursts while hunting / closing on a target beyond `burstRange`.
   * - `flankOffset`: approaches a remembered target from the side, this far off the line (m).
   * - `holdSeconds`: with nobody to hunt, holds a covered spot this long before moving on.
   * - `reloadPush`: rushes a target seen reloading (the animation every player sees).
   * - `grenadeScale`: × the frag chance.
   * - `ride` / `drive`: chance to hop into a nearby truck / to take its wheel.
   */
  personalityOrder: ['rusher', 'flanker', 'anchor', 'marksman'] as readonly BotPersonalityId[],
  /** Trucks (bots ride along, then drive; `server/src/bots/vehicleBrain.ts`). */
  vehicle: {
    /** A truck this close (m) is noticed (the engine is heard); farther needs a clear line. */
    noticeRange: 30,
    /** Go for a truck only within this walk (m) and when no enemy is closer than `fightRange`. */
    walkRange: 28,
    fightRange: 14,
    /** Seconds between tries at a truck (a decision, not a loop); after declining one, sooner. */
    retrySeconds: 10,
    declineSeconds: 4,
    /** Passengers get out after the truck has stood still this long (s) with nobody to shoot. */
    idleExitSeconds: 3,
    /** Everyone bails below this share of the truck's health. */
    bailHealth: 0.25,
    /**
     * Driving: cruise speed (m/s), slowed for turns; pure-pursuit lookahead (m, + per m/s);
     * braking for the next corner (m/s²) down to at least `cornerSpeed` (m/s) through a right
     * angle; roam goals at least this far (m) on the truck's network.
     */
    cruise: 12,
    cornerSpeed: 6,
    lookahead: 4.5,
    lookaheadPerSpeed: 0.3,
    cornerBrake: 5,
    roamMinDistance: 30,
    /**
     * Stuck: throttle on, slower than this (m/s) for `stuckSeconds` → back out, nose swinging
     * toward the way on, for up to `reverseSeconds` (less once it points there).
     */
    stuckSpeed: 0.8,
    stuckSeconds: 1,
    reverseSeconds: 2.5,
    /** This many back-outs within `stuckForgetSeconds` → get out and fight on foot. */
    giveUpAfter: 3,
    stuckForgetSeconds: 15,
    /** A driver with an enemy in sight this close (m) gets out to fight (rushers ram instead). */
    exitToFight: 16,
    /** A rusher at the wheel rams enemies on foot within this (m). */
    ramRange: 35,
  },
  personalities: {
    rusher: {
      label: 'Rusher',
      callsigns: ['Taran', 'Dzik'],
      primaries: ['shotgun', 'iskra', 'ar7'],
      rangeScale: 0.7,
      strafeScale: 1.1,
      coverHealth: 0.2,
      crouchFire: 0,
      tacSprint: true,
      burstRange: 14,
      flankOffset: 0,
      holdSeconds: 0,
      reloadPush: true,
      grenadeScale: 0.6,
      ride: 0.85,
      drive: 0.9,
      ram: true,
    },
    flanker: {
      label: 'Flanker',
      callsigns: ['Lis', 'Ryś'],
      primaries: ['iskra', 'ar7', 'arc'],
      rangeScale: 0.9,
      strafeScale: 1.1,
      coverHealth: 0.35,
      crouchFire: 0,
      tacSprint: true,
      burstRange: 22,
      flankOffset: 9,
      holdSeconds: 0,
      reloadPush: true,
      grenadeScale: 1,
      ride: 0.75,
      drive: 0.8,
      ram: false,
    },
    anchor: {
      label: 'Anchor',
      callsigns: ['Kotwica', 'Mur'],
      primaries: ['ar7', 'arc', 'coil'],
      rangeScale: 1.3,
      strafeScale: 0.5,
      coverHealth: 0.5,
      crouchFire: 0.55,
      tacSprint: false,
      burstRange: 0,
      flankOffset: 0,
      holdSeconds: 7,
      reloadPush: false,
      grenadeScale: 1.4,
      ride: 0.2,
      drive: 0,
      ram: false,
    },
    marksman: {
      label: 'Marksman',
      callsigns: ['Jastrząb', 'Sowa'],
      primaries: ['marksman', 'coil', 'ar7'],
      rangeScale: 1.4,
      strafeScale: 1,
      coverHealth: 0.45,
      crouchFire: 0.35,
      tacSprint: false,
      burstRange: 0,
      flankOffset: 0,
      holdSeconds: 4,
      reloadPush: false,
      grenadeScale: 0.8,
      ride: 0.35,
      drive: 0,
      ram: false,
    },
  } satisfies Record<BotPersonalityId, BotPersonality>,
};

/** How a bot plays (`BOT.personalities`). */
export type BotPersonalityId = 'rusher' | 'flanker' | 'anchor' | 'marksman';
export interface BotPersonality {
  label: string;
  callsigns: readonly string[];
  primaries: readonly PrimaryId[];
  rangeScale: number;
  strafeScale: number;
  coverHealth: number;
  crouchFire: number;
  tacSprint: boolean;
  burstRange: number;
  flankOffset: number;
  holdSeconds: number;
  reloadPush: boolean;
  grenadeScale: number;
  /**
   * Trucks: the chance to hop into a nearby one (`ride`, any free seat) and to take the wheel
   * when the driver's seat is free (`drive`); rushers and flankers love it, anchors hold ground.
   */
  ride: number;
  drive: number;
  /** At the wheel, drives at enemies on foot (run-overs) instead of getting out to fight. */
  ram: boolean;
}

export const MOVEMENT = {
  walkSpeed: 4.6,
  sprintSpeed: 6.9,
  /** Low run (Sprint + Crouch): a crouched-over run — slower than a full sprint, lower and quieter. */
  lowRunSpeed: 5.8,
  crouchSpeed: 2.3,
  /** Speed multiplier while fully aimed down sights. */
  adsSpeedMultiplier: 0.62,
  /** Backwards/strafe cap relative to forward speed while walking. */
  backpedalMultiplier: 0.85,
  /** Ground acceleration toward target speed (m/s²). Higher = snappier, lower = heavier. */
  groundAcceleration: 38,
  /** Ground deceleration when there's no input (m/s²). */
  groundDeceleration: 30,
  /** Air acceleration (m/s²). Small = committed jumps. */
  airAcceleration: 7,
  jumpHeight: 1.05,
  gravity: 22,
  /** Terminal fall speed (m/s). */
  maxFallSpeed: 40,
  /** Grace period after walking off a ledge during which a jump still works (s). */
  coyoteTime: 0.1,
  /** A jump pressed this long before landing still fires on landing (s). */
  jumpBufferTime: 0.12,
  /** Speed multiplier applied for a moment after landing a jump (weighty landings). */
  landingSlowMultiplier: 0.7,
  landingSlowTime: 0.18,
  /** Stick deflection needed on the forward axis to keep sprinting. */
  sprintMinForward: 0.5,
  /** Distance travelled per footstep while walking (m); sprint/crouch scale from this. */
  strideLength: 1.9,
};

/**
 * Player-vs-player collision (Kiran 2026-09-30: "soft push"). Living players are vertical
 * cylinders to each other (prone too: the longer prone footprint is a hit volume, not a collision
 * one). You can't walk into someone deeper than `walkPenetration`; overlap is resolved gently
 * over a few steps by each player moving itself (so the client predicts its own share from
 * positions it knows), through the character controller, so a push never goes into a wall.
 * Separate from hit volumes: bullets, knives and lag compensation never see this.
 */
export const PLAYER_COLLISION = {
  enabled: true,
  /** Cylinder radius (m): narrower than the world capsule, shoulders may brush. */
  radius: 0.3,
  /** Overlap your own walking can reach before it stops (m): a bump, not a wall. */
  walkPenetration: 0.12,
  /** Share of the remaining overlap a player resolves itself each step (both do: 2x together). */
  resolveRate: 0.2,
  /**
   * Cap on how fast being pushed moves you (m/s): a sprinter shoves a standing player at about
   * `resolveRate * walkPenetration * tickHz` (≈ 1.4 m/s), never faster than this.
   */
  maxPushSpeed: 1.75,
  /** Your velocity into someone you're pressed against is cut to this (m/s): lunges stop there. */
  shoveSpeed: 1.5,
  /**
   * Head-on (their centre within `slipBand` m of your line of motion): you sidestep to your own
   * right at `slipSpeed` (m/s), so two players meeting in a corridor pass each other and nobody
   * stops anyone dead.
   */
  slipBand: 0.18,
  slipSpeed: 1.2,
};

export const CHARACTER = {
  /** Autostep: max step height climbed without jumping (m). */
  stepHeight: 0.42,
  stepMinWidth: 0.15,
  maxSlopeClimbDeg: 46,
  minSlopeSlideDeg: 50,
  snapToGround: 0.35,
  /** Rapier KCC skin offset (m). */
  skin: 0.02,
};

export const RIFLE = {
  name: 'AR-7 rifle',
  /** Semi-automatic weapons fire once per trigger press. */
  semiAuto: false,
  /** Hold the trigger this long before each shot releases (coilgun charge; 0 = none). */
  chargeTime: 0,
  /** Smart rounds: bend toward a visible target within this cone of the aim (0 = off)… */
  homingConeDeg: 0,
  /** …by at most this much (degrees). */
  homingMaxBendDeg: 0,
  /** No muzzle flash and a quiet report (heard at short range only). */
  silent: false,
  /** Pellets per trigger pull (shotgun) and their fixed cone half-angle (degrees). */
  pellets: 1,
  pelletSpreadDeg: 0,
  /** Full-screen scope overlay at full ADS (marksman optics). */
  scope: false,
  /**
   * Energy weapons: no magazine; each shot adds `perShot` heat (1 = overheated), which cools at
   * `coolRate`/s after `coolDelay` s; overheating locks the trigger for `lockout` s.
   */
  heat: null as null | { perShot: number; coolRate: number; coolDelay: number; lockout: number },
  /** Tracer / muzzle tint (presentation): 'bullet' or 'arc' (cyan energy). */
  tracer: 'bullet' as 'bullet' | 'arc',
  /** Time to raise this weapon after switching to it (s). */
  equipTime: 0.45,
  roundsPerMinute: 720,
  magazineSize: 30,
  reserveAmmo: 120,
  /** Base damage per bullet at close range. */
  damage: 25,
  headMultiplier: 2.0,
  legMultiplier: 0.85,
  /** Full damage up to this range (m)… */
  falloffStart: 28,
  /** …linearly dropping to `falloffMinMultiplier` at this range. */
  falloffEnd: 65,
  falloffMinMultiplier: 0.72,
  maxRange: 300,
  /** Reload time with rounds left in the magazine. */
  reloadTime: 2.1,
  /** Reload time from empty (bolt release). */
  reloadEmptyTime: 2.6,
  /** Delay after sprinting before the weapon can fire. */
  sprintToFireTime: 0.18,
  /** Time to fully aim down sights. */
  adsTime: 0.2,
  /** Zoom factor while fully aimed (FOV is divided by this). */
  adsZoom: 1.35,
  /** Spread (cone half-angle, degrees). */
  spread: {
    hipStand: 1.6,
    hipCrouch: 1.2,
    ads: 0.12,
    /** Added at full movement speed (scaled by speed / walkSpeed, reduced 85% in ADS). */
    moving: 1.6,
    airborne: 4.5,
    /** Added per shot (bloom)… */
    bloomPerShot: 0.35,
    /** …capped at… */
    bloomMax: 2.8,
    /** …recovering at this rate (deg/s) once you stop firing. */
    bloomRecovery: 6,
    adsBloomMultiplier: 0.35,
  },
  recoil: {
    /**
     * Per-shot aim kick (degrees). [pitchUp, yawRight]. Shots past the end repeat the last 8.
     * Learnable: climbs straight, then drifts right, then left.
     */
    pattern: [
      [0.9, 0.0],
      [0.9, 0.05],
      [0.85, 0.1],
      [0.8, 0.05],
      [0.75, 0.15],
      [0.7, 0.25],
      [0.65, 0.3],
      [0.6, 0.2],
      [0.55, 0.05],
      [0.55, -0.2],
      [0.5, -0.35],
      [0.5, -0.35],
      [0.45, -0.2],
      [0.45, 0.1],
      [0.45, 0.3],
      [0.45, 0.25],
    ] as [number, number][],
    /** Random horizontal jitter added per shot (± degrees). */
    yawJitter: 0.12,
    adsMultiplier: 0.7,
    crouchMultiplier: 0.85,
    /** How fast the aim offset returns to centre when not firing (deg/s). */
    recoveryRate: 9,
    /** Delay after the last shot before recovery starts. */
    recoveryDelay: 0.08,
    /** Pattern restarts after this long without firing. */
    patternResetTime: 0.35,
  },
};

export const SIDEARM: typeof RIFLE = {
  name: 'P-9 pistol',
  semiAuto: true,
  chargeTime: 0,
  homingConeDeg: 0,
  homingMaxBendDeg: 0,
  silent: false,
  pellets: 1,
  pelletSpreadDeg: 0,
  scope: false,
  heat: null,
  tracer: 'bullet',
  equipTime: 0.3,
  /** Cap for how fast the trigger can be tapped. */
  roundsPerMinute: 420,
  magazineSize: 15,
  reserveAmmo: 60,
  damage: 34,
  headMultiplier: 2.0,
  legMultiplier: 0.85,
  falloffStart: 14,
  falloffEnd: 40,
  falloffMinMultiplier: 0.6,
  maxRange: 150,
  reloadTime: 1.5,
  reloadEmptyTime: 1.8,
  sprintToFireTime: 0.1,
  adsTime: 0.15,
  adsZoom: 1.18,
  spread: {
    hipStand: 1.1,
    hipCrouch: 0.9,
    ads: 0.22,
    moving: 1.0,
    airborne: 3.5,
    bloomPerShot: 0.55,
    bloomMax: 2.4,
    bloomRecovery: 7,
    adsBloomMultiplier: 0.5,
  },
  recoil: {
    pattern: [
      [1.5, 0.1],
      [1.45, -0.15],
      [1.4, 0.2],
      [1.4, -0.1],
    ],
    yawJitter: 0.25,
    adsMultiplier: 0.8,
    crouchMultiplier: 0.85,
    recoveryRate: 14,
    recoveryDelay: 0.05,
    patternResetTime: 0.3,
  },
};

/**
 * KS-9 "Cewka" coilgun (marksman primary): magnetic, silent, a short charge per shot, two
 * headshots or three body shots. Slow and weak from the hip: it rewards patience in long lanes.
 */
export const COILGUN: typeof RIFLE = {
  name: 'KS-9 Cewka',
  semiAuto: true,
  chargeTime: 0.25,
  homingConeDeg: 0,
  homingMaxBendDeg: 0,
  silent: true,
  pellets: 1,
  pelletSpreadDeg: 0,
  scope: true,
  heat: null,
  tracer: 'bullet',
  equipTime: 0.6,
  roundsPerMinute: 75,
  magazineSize: 5,
  reserveAmmo: 25,
  damage: 48,
  headMultiplier: 2.0,
  legMultiplier: 0.85,
  falloffStart: 60,
  falloffEnd: 120,
  falloffMinMultiplier: 0.85,
  maxRange: 300,
  reloadTime: 2.6,
  reloadEmptyTime: 3.0,
  sprintToFireTime: 0.25,
  adsTime: 0.28,
  adsZoom: 2.2,
  spread: {
    hipStand: 2.6,
    hipCrouch: 2.0,
    ads: 0.03,
    moving: 2.5,
    airborne: 6,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomRecovery: 6,
    adsBloomMultiplier: 0,
  },
  recoil: {
    pattern: [[3.2, 0.2]],
    yawJitter: 0.3,
    adsMultiplier: 0.8,
    crouchMultiplier: 0.85,
    recoveryRate: 7,
    recoveryDelay: 0.12,
    patternResetTime: 0.5,
  },
};

/**
 * "Iskra" smart SMG (close-quarters primary): very fast, low damage, and its rounds bend a
 * little toward a visible target near the aim — the shared hitscan does the bending, so the
 * server resolves it exactly the same (fair online). Falls off hard past 30 m.
 */
export const ISKRA: typeof RIFLE = {
  name: 'Iskra SMG',
  semiAuto: false,
  chargeTime: 0,
  homingConeDeg: 3,
  homingMaxBendDeg: 2,
  silent: false,
  pellets: 1,
  pelletSpreadDeg: 0,
  scope: false,
  heat: null,
  tracer: 'bullet',
  equipTime: 0.35,
  roundsPerMinute: 1000,
  magazineSize: 36,
  reserveAmmo: 144,
  damage: 16,
  headMultiplier: 1.6,
  legMultiplier: 0.9,
  falloffStart: 10,
  falloffEnd: 30,
  falloffMinMultiplier: 0.55,
  maxRange: 150,
  reloadTime: 1.9,
  reloadEmptyTime: 2.3,
  sprintToFireTime: 0.12,
  adsTime: 0.16,
  adsZoom: 1.2,
  spread: {
    hipStand: 1.4,
    hipCrouch: 1.1,
    ads: 0.5,
    moving: 0.8,
    airborne: 3,
    bloomPerShot: 0.18,
    bloomMax: 2.2,
    bloomRecovery: 8,
    adsBloomMultiplier: 0.5,
  },
  recoil: {
    pattern: [
      [0.45, 0.05],
      [0.45, -0.08],
      [0.4, 0.1],
      [0.4, -0.05],
      [0.35, 0.12],
      [0.35, -0.12],
    ],
    yawJitter: 0.18,
    adsMultiplier: 0.75,
    crouchMultiplier: 0.85,
    recoveryRate: 10,
    recoveryDelay: 0.06,
    patternResetTime: 0.3,
  },
};

/**
 * M-12 "Grom" pump shotgun (close quarters): nine pellets, a one-pull kill up close, nearly
 * harmless past 25 m. Pellets are deterministic from the shot seed (the server traces the same).
 */
export const SHOTGUN: typeof RIFLE = {
  name: 'M-12 Grom',
  semiAuto: true,
  chargeTime: 0,
  homingConeDeg: 0,
  homingMaxBendDeg: 0,
  silent: false,
  pellets: 9,
  pelletSpreadDeg: 4.2,
  scope: false,
  heat: null,
  tracer: 'bullet',
  equipTime: 0.5,
  roundsPerMinute: 68,
  magazineSize: 7,
  reserveAmmo: 28,
  damage: 17,
  headMultiplier: 1.4,
  legMultiplier: 0.9,
  falloffStart: 7,
  falloffEnd: 24,
  falloffMinMultiplier: 0.2,
  maxRange: 60,
  reloadTime: 3.0,
  reloadEmptyTime: 3.4,
  sprintToFireTime: 0.2,
  adsTime: 0.2,
  adsZoom: 1.15,
  spread: {
    hipStand: 0.8,
    hipCrouch: 0.6,
    ads: 0.5,
    moving: 0.6,
    airborne: 2,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomRecovery: 6,
    adsBloomMultiplier: 0,
  },
  recoil: {
    pattern: [[4.2, 0.35]],
    yawJitter: 0.5,
    adsMultiplier: 0.85,
    crouchMultiplier: 0.85,
    recoveryRate: 9,
    recoveryDelay: 0.1,
    patternResetTime: 0.6,
  },
};

/**
 * SR-8 "Sokół" marksman rifle (long lanes): semi-auto, 3x scope, a headshot kills and two body
 * shots do; clumsy from the hip.
 */
export const MARKSMAN: typeof RIFLE = {
  name: 'SR-8 Sokół',
  semiAuto: true,
  chargeTime: 0,
  homingConeDeg: 0,
  homingMaxBendDeg: 0,
  silent: false,
  pellets: 1,
  pelletSpreadDeg: 0,
  scope: true,
  heat: null,
  tracer: 'bullet',
  equipTime: 0.6,
  roundsPerMinute: 190,
  magazineSize: 10,
  reserveAmmo: 40,
  damage: 58,
  headMultiplier: 2.0,
  legMultiplier: 0.85,
  falloffStart: 50,
  falloffEnd: 110,
  falloffMinMultiplier: 0.8,
  maxRange: 300,
  reloadTime: 2.4,
  reloadEmptyTime: 2.9,
  sprintToFireTime: 0.25,
  adsTime: 0.3,
  adsZoom: 3.0,
  spread: {
    hipStand: 2.4,
    hipCrouch: 1.9,
    ads: 0.02,
    moving: 2.2,
    airborne: 6,
    bloomPerShot: 0.3,
    bloomMax: 1.2,
    bloomRecovery: 4,
    adsBloomMultiplier: 0.2,
  },
  recoil: {
    pattern: [[2.6, 0.15]],
    yawJitter: 0.25,
    adsMultiplier: 0.8,
    crouchMultiplier: 0.85,
    recoveryRate: 8,
    recoveryDelay: 0.1,
    patternResetTime: 0.5,
  },
};

/**
 * ŁUK-3 arc rifle (energy): no magazine — it heats up (~20 shots to overheat) and cools when you
 * ease off; overheating locks the trigger for 1.6 s. Cyan bolts, light recoil.
 */
export const ARC: typeof RIFLE = {
  name: 'ŁUK-3 arc rifle',
  semiAuto: false,
  chargeTime: 0,
  homingConeDeg: 0,
  homingMaxBendDeg: 0,
  silent: false,
  pellets: 1,
  pelletSpreadDeg: 0,
  scope: false,
  heat: { perShot: 0.05, coolRate: 0.6, coolDelay: 0.3, lockout: 1.6 },
  tracer: 'arc',
  equipTime: 0.45,
  roundsPerMinute: 560,
  magazineSize: 100,
  reserveAmmo: 0,
  damage: 21,
  headMultiplier: 1.7,
  legMultiplier: 0.9,
  falloffStart: 20,
  falloffEnd: 45,
  falloffMinMultiplier: 0.65,
  maxRange: 200,
  reloadTime: 1,
  reloadEmptyTime: 1,
  sprintToFireTime: 0.15,
  adsTime: 0.2,
  adsZoom: 1.3,
  spread: {
    hipStand: 1.3,
    hipCrouch: 1.0,
    ads: 0.18,
    moving: 1.2,
    airborne: 3.5,
    bloomPerShot: 0.12,
    bloomMax: 1.6,
    bloomRecovery: 7,
    adsBloomMultiplier: 0.4,
  },
  recoil: {
    pattern: [
      [0.35, 0.02],
      [0.35, -0.04],
      [0.32, 0.05],
      [0.32, -0.03],
    ],
    yawJitter: 0.1,
    adsMultiplier: 0.75,
    crouchMultiplier: 0.85,
    recoveryRate: 11,
    recoveryDelay: 0.06,
    patternResetTime: 0.3,
  },
};

/** Primary weapons a player can pick (loadout; the sidearm is always the P-9). */
export const PRIMARIES = {
  ar7: RIFLE,
  coil: COILGUN,
  iskra: ISKRA,
  shotgun: SHOTGUN,
  marksman: MARKSMAN,
  arc: ARC,
} as const;
export type PrimaryId = keyof typeof PRIMARIES;
/** Appended only (the index rides in snapshots). */
export const PRIMARY_IDS: readonly PrimaryId[] = [
  'ar7',
  'coil',
  'iskra',
  'shotgun',
  'marksman',
  'arc',
];

export const KNIFE = {
  name: 'Combat knife',
  /**
   * Combo (Krav Maga style): consecutive strikes chain slash (right→left), backhand
   * (left→right), thrust; the chain resets after `comboResetTime` without a strike.
   */
  comboResetTime: 0.65,
  /** Two slashes kill from full health; the thrust hits a little harder. */
  damage: 55,
  thrustDamage: 65,
  /** Reach from the eye (m); the thrust reaches further. */
  range: 2.6,
  thrustRange: 3.0,
  /** Slashes sweep a fan of rays across this arc (degrees) — a wide swipe, not a pinpoint. */
  slashArcDeg: 70,
  slashRays: 9,
  /** The thrust is a narrow cone (degrees). */
  thrustArcDeg: 16,
  /** Blade sweep: target hit volumes are inflated by this much for melee (m). */
  sweepRadius: 0.3,
  /** Wind-up of follow-up strikes in a combo (s): fast once the chain has started. */
  windup: 0.07,
  /** Wind-up of a combo's opening strike: the visible chamber (tell) a defender can read (s). */
  openingWindup: 0.22,
  /** Wind-up of a counter-strike right after a successful parry (s). */
  counterWindup: 0.03,
  /** Recovery after the hit before the next strike (knife in hand) (s). */
  recovery: 0.3,
  /** Extra time for a quick-melee (Q) from a gun: holster + re-raise (s). */
  quickMeleeExtra: 0.22,
  /** Forward lunge on each strike: horizontal speed added along the view (m/s), then shed by
   * normal ground deceleration (≈0.5 m of travel). */
  lungeSpeed: 6.5,
  equipTime: 0.2,
  /** Movement speed multiplier while holding the knife (lighter than a rifle). */
  speedMultiplier: 1.07,
};

/**
 * Knife defense (Krav Maga-inspired): hold Block to guard with the forearm (the "360°" outside
 * defense); press it just before a strike lands to parry (the "burst": defend and counter at once).
 */
export const KNIFE_DEFENSE = {
  /** Guard only covers strikes from the front arc (degrees, total). Behind you = no defense. */
  frontArcDeg: 150,
  /** Guarded strikes deal this fraction of damage. */
  guardDamageMultiplier: 0.25,
  /** Guard breaks after this many blocked strikes… */
  guardMaxBlocks: 3,
  /** …leaving the defender briefly stunned, and unable to guard for a while (s). */
  guardBreakStun: 0.5,
  guardRecovery: 1.5,
  /** Moving while guarding is slower. */
  guardSpeedMultiplier: 0.55,
  /** Block pressed within this long before a slash lands = parry (s). Thrusts are tighter. */
  parryWindow: 0.25,
  thrustParryWindow: 0.15,
  /** A parried attacker is stunned (can't strike, shoot or switch) and shoved back. */
  parryStun: 0.7,
  parryPushback: 5,
  /** After a parry the defender's next strike is near-instant and hits harder, for this long (s). */
  counterWindow: 0.8,
  counterBonusDamage: 20,
  /** Movement speed while stunned. */
  stunSpeedMultiplier: 0.4,
};

export const GRENADE = {
  name: 'Frag grenade',
  perLife: 1,
  /** Fuse from release (s). */
  fuse: 3.0,
  /** Throw speed (m/s) and extra upward angle (degrees). */
  throwSpeed: 17,
  throwUpAngle: 9,
  /** Pull-pin + wind-up before release (s). */
  windup: 0.32,
  /** Recovery after release before weapons are usable again (s). */
  recovery: 0.35,
  gravity: 16,
  /** Collision radius of the grenade body (m). */
  radius: 0.07,
  /** Bounciness (0 dead, 1 perfect) and tangential damping on impact. */
  restitution: 0.35,
  friction: 0.65,
  /** Full damage inside innerRadius, linear falloff to minDamage at radius, none beyond. */
  maxDamage: 130,
  minDamage: 12,
  innerRadius: 1.6,
  blastRadius: 7,
};

/** Thermal-blocking smoke grenade (tactical: blocks sight, drones, thermal and bots). */
export const SMOKE = {
  name: 'Smoke grenade',
  perLife: 1,
  /** Fuse from release (s): pops quickly, even mid-bounce. */
  fuse: 1.2,
  /** Cloud radius when fully bloomed (m). */
  radius: 6,
  /** Seconds to bloom to full size, hold, and thin out. */
  bloom: 2,
  hold: 12,
  fade: 3,
  /** Metres of smoke along a sight line that hide a target completely. */
  blockDepth: 2,
};

/** FPV recon drone (called in with a drone charge from a drone uplink). */
export const DRONE = {
  /** Flight time (s). */
  battery: 15,
  speed: 11,
  /** Horizontal acceleration (m/s^2) and vertical speed (m/s). */
  accel: 30,
  climb: 5,
  /** Collision radius (m) and the highest it may fly above its launch point (m). */
  radius: 0.3,
  maxAltitude: 40,
  /** Spotting: anyone inside the camera cone, in range, in the clear gets marked. */
  spotRange: 60,
  spotFovDeg: 70,
  /** How long a spotted player stays on the pilot's radar (s). */
  spotTime: 6,
};

/** Handheld drone jammer (electronic-warfare pulse). */
export const JAMMER = {
  perLife: 1,
  /** Pulse radius (m): drones inside are knocked down, other players' radars are jammed. */
  radius: 25,
  /** How long a jammed radar shows static (s). */
  radarJam: 8,
};

export type MatchMode = 'standard' | 'knife';

/** Free-for-all match rules (online, server-authoritative from M3b). */
export const MATCH = {
  /** First to this many kills wins. */
  scoreLimit: 25,
  /** Match length (s). At the whistle most kills wins; equal kills and deaths share the win. */
  timeLimit: 600,
  /** Seconds a killed player waits before respawning. */
  respawnDelay: 3,
  /** Seconds the results stay up before the next match starts (scores reset, everyone respawns). */
  intermission: 10,
};

/**
 * Spawn protection (brief: "2 seconds, or until the player fires"): no damage of any kind after
 * each (re)spawn until it runs out or the player attacks (a shot, a knife swing, a throw). It
 * grants nothing else: no speed, no damage, no extra sight.
 */
export const SPAWN_PROTECTION = {
  /** Seconds of protection after every spawn. */
  duration: 3,
};

/** Safest spawn (brief: "score by distance and line of sight to living enemies"). */
export const SPAWN_SAFETY = {
  /**
   * Metres of distance each living enemy with a clear line of sight to the spawn costs: larger
   * than any map, so a spawn seen by fewer enemies always wins; distance breaks the rest.
   */
  seenPenalty: 1000,
};

/** Presentation-only feel values (client). Do not affect simulation outcomes. */
export const FEEL = {
  /** FOV multiplier at full sprint. */
  sprintFovMultiplier: 1.05,
  /** A tactical sprint burst drives the sprint FOV kick this many times as far (1.05 → 1.09). */
  tacSprintFovScale: 1.8,
  /** Camera roll kick per shot (degrees), springs back. */
  shotRollKick: 0.35,
  /** Viewmodel kickback per shot (m). */
  viewmodelKick: 0.045,
  /** Landing camera dip per m/s of impact speed (m), capped. */
  landDipPerSpeed: 0.012,
  landDipMax: 0.14,
  /** Head bob amplitude (m) at walk speed (settings can disable). */
  bobAmplitude: 0.018,
  /** Weapon sway from mouse movement (radians per degree of look), and its limit. */
  swayPerDegree: 0.004,
  swayMax: 0.06,
  /** Slide: camera roll (degrees) and FOV multiplier at full slide (both eased). */
  slideRollDeg: 5,
  slideFovMultiplier: 1.06,
};

export const DUMMY = {
  maxHealth: 100,
  respawnTime: 2,
};

/** All tunables grouped (for the dev tuning panel and "copy as TS"). */
/** Climbing and vaulting (see sim/traversal.ts). */
export const TRAVERSAL = {
  /** How far in front of the capsule an obstacle counts (m). */
  reach: 0.55,
  /** Lower than this, just walk/step or jump (m). */
  minHeight: 0.45,
  /** Max obstacle height you can vault over while sprinting (m). */
  maxVault: 1.25,
  /** Max ledge height you can pull yourself up onto (m) — reachable from standing or mid-jump. */
  maxMantle: 2.3,
  /** Absolute cap above the ground you jumped from (a jump + grab reaches container roofs,
   *  not 3 m walls). */
  maxFromGround: 2.7,
  /** Extra reach per m/s of running speed (sprinters start a vault from further out). */
  reachPerSpeed: 0.12,
  /** Vault duration (s). */
  vaultTime: 0.42,
  /** Mantle duration: base + per metre climbed (s). */
  mantleBase: 0.28,
  mantlePerMetre: 0.17,
  /** Horizontal speed kept after a vault, as a fraction of sprint speed. */
  vaultCarry: 0.85,
};

/**
 * The skateboard (Kiran): one per match at a secret spot; walk over it to ride until you die,
 * then it lies where you fell for anyone else. See sim/skateboard.ts and movement.ts.
 */
export const SKATEBOARD = {
  /** Top rolling speed while pushing (m/s): well above a sprint (6.9). */
  cruiseSpeed: 9.2,
  /** Push acceleration (m/s²): a few kicks to get up to speed. */
  pushAccel: 7,
  /** Rolling friction when coasting (m/s²): momentum carries. */
  coastDecel: 0.6,
  /** Braking (back key) (m/s²). */
  brakeDecel: 9,
  /** Fastest carve (rad/s, low speed), and the sideways grip that limits it at speed (m/s²):
   * ~1.3 g, so a turn at cruise is ~7 m wide, not a pivot. In the air: a small body turn. */
  turnRate: 3.4,
  lateralAccel: 12,
  airTurnRate: 0.7,
  /** Wheels roll over lips up to this (m, with a bump); anything higher needs an ollie. */
  maxStep: 0.16,
  /** Speed kept per step-up bump. */
  bumpKeep: 0.85,
  /** Speed lost scraping along a wall: this × the fraction of the move the wall took, per step. */
  scrape: 0.08,
  /** Share of gravity along a slope that speeds you downhill / slows you uphill. */
  slopeFactor: 0.5,
  /** Below this speed the board simply points where you look (m/s). */
  pivotSpeed: 0.6,
  /** Pickup reach (m, horizontal) and height tolerance. */
  pickupRadius: 1.1,
  pickupHeight: 1.2,
} as const;

/**
 * Medkits (Kiran: health comes back only from pickups, no regeneration): walk over one while
 * hurt to heal; a full-health player walks past, leaving it for others.
 */
export const MEDKIT = {
  heal: 50,
  respawn: 30,
  pickupRadius: 1.1,
} as const;

/** Fallen primary guns: shared by the authoritative match and local prediction. */
export const WEAPON_DROP = {
  ttl: 30,
  pickupRadius: 1.1,
  swapRadius: 1.6,
  pickupHeight: 1.5,
  cap: 24,
} as const;

/** Radar uplinks (collectable radar, see sim/pickups.ts). */
export const RADAR = {
  /** Walk within this distance of an uplink to collect it (m). */
  pickupRadius: 1.4,
  /** How long a called-in radar shows everyone (s). */
  duration: 10,
  /** Radar charges you can hold (collect at an uplink, call in with the Radar key). */
  maxCharges: 1,
  /** Uplink recharge after being collected (s). */
  respawn: 40,
  /** Radar display range (m, radius). */
  range: 70,
};

/**
 * The armored 4x4 truck (Kiran, 2026-10-01: moving cover and fast flanks on the Market). Arcade
 * kinematic model integrated by the shared sim (`sim/vehicles/vehicle.ts`), so the driver's
 * prediction is the server's code. Geometry lives in `sim/vehicles/truckSpec.ts`.
 *
 * Feel: a heavy armoured truck that still answers at once. 0 → 50 km/h in ~3 s (a sprinting
 * player, 6.9 m/s, is caught in ~1.3 s), 58 km/h top: in a 130 m quarter that is a lane in ~6 s,
 * fast enough to flank, slow enough to shoot at. Steering is speed-sensitive (full lock only at
 * walking pace) and the yaw rate is capped by tyre grip (~0.85 g), so it never pivots at speed
 * or twitches on a tap; the handbrake drops the rear grip for a drift round a corner.
 */
export const VEHICLE = {
  maxHealth: 800,
  /** Forward / reverse top speed (m/s). */
  topSpeed: 16,
  reverseSpeed: 6,
  /** Engine acceleration at standstill (m/s²); fades with speed toward the top speed. */
  accel: 6.5,
  reverseAccel: 4,
  /** Service brake (m/s²): from top speed to a stop in ~1.2 s, ~19 m. */
  brakeDecel: 13,
  /** Engine braking + rolling resistance off the throttle (m/s²). */
  coastDecel: 1.8,
  /** Handbrake deceleration (m/s²) and the rear grip left while it is held. */
  handbrakeDecel: 6,
  handbrakeGrip: 0.3,
  /** Steering lock at walking pace / at top speed (rad), and how fast the wheel turns (rad/s). */
  maxSteer: 0.6,
  minSteer: 0.16,
  steerRate: 2.6,
  steerReturnRate: 4,
  /** Tyre grip: sideways slip bled off per second (m/s²) and the cornering limit (m/s²). */
  lateralGrip: 22,
  maxLateralAccel: 8.5,
  /** The yaw rate follows the steering this fast (1/s): no snap, no lag. */
  yawResponse: 9,
  /** Handbrake turn-in: the yaw rate target is multiplied by this while drifting. */
  handbrakeYaw: 1.5,
  /** Lips the wheels climb (m); taller obstacles stop the body (`truckSpec.collisionBox`). */
  maxStep: 0.36,
  /** Suspension: droop before a wheel leaves the ground (m), spring (1/s²) and damping (1/s). */
  droop: 0.3,
  spring: 260,
  damping: 26,
  /** Body pitch/roll follow the ground under the wheels this fast (1/s); clamped (rad). */
  tiltResponse: 10,
  maxTilt: 0.45,
  gravity: 20,
  /**
   * Walls: the speed along a wall loses this × the impact speed, and the body turns to run along
   * it (yaw rate per rad of misalignment per m/s of impact).
   */
  wallScrape: 0.3,
  wallTurn: 1.2,
  /** Interact reach: the nearest free seat within this of the player (m, from the body). */
  enterReach: 2.4,
  /** Seconds between seat changes (enter/exit/switch spam). */
  seatCooldown: 0.5,
  // ---- combat ----
  /** Damage multipliers by weapon (armour). */
  bulletDamage: 0.5,
  arcDamage: 1.4,
  fragDamage: 2.2,
  knifeDamage: 0,
  /** A round through the cab glass keeps this share of its damage. */
  glassDamage: 0.6,
  /** A frag blast reaching cab occupants keeps this share (the cab shields them). */
  cabBlastDamage: 0.5,
  /** Destruction: blast damage at the hull and its reach (m), occupants take `occupantBlast`. */
  explosionDamage: 110,
  explosionRadius: 8,
  occupantBlast: 140,
  /** The wreck stays this long (s); the truck is back at its spawn after `respawnDelay` (s). */
  wreckTime: 8,
  respawnDelay: 25,
  /**
   * Run-overs: relative speed into a player above `runOverSpeed` (m/s) hurts, `runOverDamage`
   * per m/s above it (8 m/s ≈ 100: a kill), at most once per `runOverCooldown` s per victim.
   * Below it the truck shoves (players are pushed out of the hull, soft-push style).
   */
  runOverSpeed: 4,
  runOverDamage: 25,
  runOverCooldown: 0.6,
  /** Fire arc of the front passenger (rad, relative to the vehicle's forward; + = left). */
  frontArcMin: -2.2,
  frontArcMax: 0.35,
} as const;

/** How a truck meets a prop model (`VEHICLE_IMPACT.props`); models not listed are solid. */
export interface PropImpactSpec {
  /** smash: bursts into debris, gone for the match; knock: tumbles (rigid body) and settles. */
  kind: 'smash' | 'knock';
  /** Mass at the model's own size (kg); an instance scales it by its volume. */
  mass: number;
  /** Closing speed below which the prop stops the truck like a wall (m/s). */
  minSpeed: number;
  /** Heavier than this once scaled (kg): solid (a big cover crate is not a chest). */
  maxMass?: number;
  /** Share of the launch speed the prop gets (a jersey barrier scrapes along the ground). */
  shove?: number;
}

/**
 * Trucks against the props in their path (server-owned rigid bodies, `PhysicsWorld.knockProp`).
 * The truck loses the momentum it hands over along the contact normal: Δv = v·(1 + e)·m/(M + m).
 * Containers, wrecks, cars, buildings, walls, sandbags, lamps and trees stay solid.
 */
export const VEHICLE_IMPACT = {
  truckMass: 3000,
  /** Restitution of a truck-prop hit. */
  restitution: 0.2,
  /** Share of the truck's own velocity a knocked prop also takes (dragged along the bumper). */
  carry: 0.35,
  /** Bumper lift: the upward launch speed per m/s of closing speed. */
  lift: 0.12,
  gravity: 9.81,
  /** A knocked prop settles when its rigid body sleeps, or after this long (s). */
  maxTumble: 5,
  /** Break-throughs one truck step may make (then the next prop is a wall). */
  maxPerStep: 6,
  props: {
    cardboard_box: { kind: 'smash', mass: 8, minSpeed: 0.5 },
    trashbag: { kind: 'smash', mass: 6, minSpeed: 0.5 },
    bin: { kind: 'knock', mass: 15, minSpeed: 1 },
    tyre: { kind: 'knock', mass: 10, minSpeed: 1 },
    drum: { kind: 'knock', mass: 60, minSpeed: 1.5 },
    utility_box: { kind: 'knock', mass: 40, minSpeed: 2 },
    crate_small: { kind: 'knock', mass: 25, minSpeed: 2, maxMass: 120 },
    crate: { kind: 'knock', mass: 45, minSpeed: 2.5, maxMass: 200 },
    jersey: { kind: 'knock', mass: 900, minSpeed: 9, shove: 0.3 },
  } as Readonly<Partial<Record<PropModelId, PropImpactSpec>>>,
} as const;

/**
 * Jetpacks (Kiran, 2026-10-02): three per match, one at each of three Market spots, no respawn
 * within the match. Ignite (Jump again in the air) → 20 s of flight, then a fast controlled
 * drop straight down. A stabilised pack, not a rocket: the sim steers the vertical speed toward
 * a target (climb / hover / descend) at a bounded rate, and horizontal thrust has inertia and
 * drag, so it reads as thrust, never noclip (see sim/jetpack.ts).
 */
export const JETPACK = {
  /** Flight window from ignition (s). */
  flightTime: 20,
  /** Ceiling above the ground beneath you (m; 15 ft). Soft: thrust fades over `ceilingFade`. */
  ceiling: 4.57,
  ceilingFade: 1.5,
  /** Above the ceiling (a roof edge flown off): settle back at this per metre over, capped (m/s). */
  overCeilingSink: 2,
  overCeilingSinkMax: 2.5,
  /** Climb speed with Jump held (m/s), and how fast the pack reaches it (m/s²). */
  climbSpeed: 5.2,
  thrustAccel: 24,
  /** No vertical input: hold altitude (vertical speed → 0 at this rate, m/s²). */
  hoverAccel: 11,
  /** Crouch held: descend at this (m/s), reached at this rate (m/s²). */
  descendSpeed: 6,
  descendAccel: 16,
  /** Ignition kick: vertical speed at least this (m/s) — a pop off the ground or out of a fall. */
  igniteBoost: 3,
  /**
   * Horizontal thrust (m/s²) against linear drag (1/s): top speed accel/drag ≈ 7.6 m/s, between
   * a sprint (6.9) and a tactical sprint (8.3); the drag's 0.5 s time constant is the inertia.
   * With no stick input the drag is stronger (the pack brakes), so it stops in ~1 s.
   */
  airAccel: 15.2,
  airDrag: 2,
  brakeDrag: 3,
  /** Aiming in flight slows the thrust like ADS slows walking. */
  adsThrustMultiplier: 0.7,
  /** The last seconds sputter: thrust ×`sputterThrust`, with cut-outs (×`sputterDip`). */
  sputterTime: 3,
  sputterThrust: 0.85,
  sputterDip: 0.45,
  /** Cut-outs per second during the sputter, and the share of each cycle that is a dip. */
  sputterRate: 3,
  sputterDuty: 0.35,
  /** Out of fuel: drop straight down at this (m/s, reached at `dropAccel`); drift dies at `dropDrag`. */
  dropSpeed: 10,
  dropAccel: 40,
  dropDrag: 8,
  /** Ground probe for the ceiling (m below the feet). */
  probeDistance: 40,
  /** Pickup reach (m, horizontal) and height tolerance (m). */
  pickupRadius: 1.2,
  pickupHeight: 1.3,
  /**
   * Shooting in flight: the jump's airborne spread × `spreadScale` (a bit worse than a jump);
   * aimed down sights in a steady hover the air term shrinks by up to `hoverAdsSteady` (an
   * exposed, slow flyer can aim; a fast one sprays). Recoil × `recoilMultiplier`.
   */
  spreadScale: 1.1,
  hoverAdsSteady: 0.6,
  /** Speed (m/s, 3-D) at which the hover counts as fully unsteady. */
  steadySpeed: 3,
  recoilMultiplier: 1.2,
} as const;

export const TUNABLES = {
  VEHICLE,
  JETPACK,
  RADAR,
  SMOKE,
  DRONE,
  JAMMER,
  PLAYER,
  MOVEMENT,
  SLIDE,
  TAC_SPRINT,
  TRAVERSAL,
  CHARACTER,
  RIFLE,
  SIDEARM,
  KNIFE,
  KNIFE_DEFENSE,
  GRENADE,
  FEEL,
  DUMMY,
  SPAWN_PROTECTION,
  SPAWN_SAFETY,
};
