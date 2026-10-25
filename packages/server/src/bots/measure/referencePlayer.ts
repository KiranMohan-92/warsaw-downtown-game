import {
  Button,
  emptyInput,
  gunConfig,
  isGun,
  mulberry32,
  PLAYER,
  sanitizeInput,
  type PlayerInput,
  type PlayerState,
  type Vec3,
} from '@wd/shared';
import type { BotObservation, BotVisiblePlayer } from '../types.ts';

/**
 * An average human, as a scripted player for measuring bots (`pnpm bots:measure`). It plays by
 * the same rules as everyone: it sees only what `buildBotObservation` shows (walls, smoke,
 * foliage, a 100° cone, the spawn-protection shimmer), reads its own HUD (health, ammo, the crosshair's recoil kick, the
 * damage direction indicator) and drives its player only through `PlayerInput`.
 *
 * The aim model follows the human motor-control literature in broad strokes: a reaction time
 * before any response, a fast ballistic flick whose duration grows with the log of the angle
 * (Fitts) and whose endpoint over/undershoots by a few percent, then corrective settling toward
 * the target (exponential), a small tremor, and tracking that lags a moving target by the
 * perceptual delay. Spray control pulls down against the recoil the player sees, partly and late.
 */
export interface ReferenceProfile {
  /** Time from first sight to the start of the flick (ms): mean and standard deviation. */
  reactionMs: number;
  reactionSdMs: number;
  /** Flick duration = base + perBit × log2(1 + angle / target width) (ms). */
  flickBaseMs: number;
  flickPerBitMs: number;
  /** Flick endpoint gain (1 = lands on target): mean and standard deviation (>1 = overshoot). */
  flickGain: number;
  flickGainSd: number;
  /** Residual error after the flick decays with this time constant (ms). */
  settleTauMs: number;
  /** Aim tremor: an Ornstein–Uhlenbeck wobble with this standard deviation (degrees) at ADS… */
  tremorDeg: number;
  /** …and correlation time (ms). */
  tremorTauMs: number;
  /** Moving targets are tracked where they were this long ago (perceptual delay, ms). */
  trackLagMs: number;
  /** Chance an engagement is aimed at head height instead of centre mass. */
  headAimChance: number;
  /** Start shooting once the crosshair is within this multiple of the torso's half width. */
  fireTolerance: number;
  /** Full-auto burst length (rounds) at mid/long range and the pause between bursts (ms). */
  burstMin: number;
  burstMax: number;
  closeBurstMin: number;
  closeBurstMax: number;
  burstPauseMs: number;
  burstPauseJitterMs: number;
  /** Fraction of the visible recoil kick pulled back down: mean and standard deviation. */
  sprayControl: number;
  sprayControlSd: number;
  /** Recoil is seen and countered this late (ms). */
  sprayLagMs: number;
  /** Chance a movement segment in a fight is a strafe (A/D), and its stick deflection. */
  strafeChance: number;
  strafeSpeed: number;
  /** Strafe segment length (ms): minimum + jitter. */
  strafeMinMs: number;
  strafeJitterMs: number;
  /** How long a lost target is chased to where it was last seen (ms). */
  memoryMs: number;
}

/** The average human the bots are tuned against (`pnpm bots:measure`). */
export const REFERENCE_PLAYER: ReferenceProfile = {
  reactionMs: 250,
  reactionSdMs: 45,
  flickBaseMs: 110,
  flickPerBitMs: 45,
  flickGain: 1.04,
  flickGainSd: 0.08,
  settleTauMs: 130,
  tremorDeg: 0.22,
  tremorTauMs: 220,
  trackLagMs: 110,
  headAimChance: 0.15,
  fireTolerance: 1.6,
  burstMin: 3,
  burstMax: 7,
  closeBurstMin: 6,
  closeBurstMax: 12,
  burstPauseMs: 220,
  burstPauseJitterMs: 160,
  sprayControl: 0.6,
  sprayControlSd: 0.15,
  sprayLagMs: 90,
  strafeChance: 0.55,
  strafeSpeed: 0.8,
  strafeMinMs: 350,
  strafeJitterMs: 550,
  memoryMs: 6000,
};

const DEG = Math.PI / 180;
/** A target out of sight for less than this is still the same fight (no new reaction, ms). */
const REACQUIRE_MS = 400;
/** Torso capsule radius (m): what "on the body" means for the fire decision. */
const TORSO_HALF_WIDTH = 0.24;

interface Flick {
  startMs: number;
  durationMs: number;
  fromYaw: number;
  fromPitch: number;
  /** Where the flick lands, relative to the (perceived) aim point at its start. */
  endErrYaw: number;
  endErrPitch: number;
}

export class ReferencePlayer {
  private readonly rng: () => number;
  private yaw = 0;
  private pitch = 0;
  private initialized = false;
  private targetId: string | null = null;
  private lastSeenMs = -Infinity;
  private lastSeenPos: Vec3 | null = null;
  /** The flick starts at this time (ms) after the target is first seen (reaction). */
  private reactAt = Infinity;
  private flick: Flick | null = null;
  /** Aim error (radians) left after the flick, decaying toward the target. */
  private errYaw = 0;
  private errPitch = 0;
  private tremorYaw = 0;
  private tremorPitch = 0;
  private aimHead = false;
  private tracking = false;
  /** Perceived target aim points (a short history, for the perceptual delay). */
  private seen: { ms: number; p: Vec3 }[] = [];
  /** Rounds in the current burst and the gun's shot counter when it began. */
  private burstLeft = 0;
  private burstStartShots = 0;
  private nextBurstAt = 0;
  private control = 0.6;
  private recoilSeen: { ms: number; pitch: number; yaw: number }[] = [];
  private strafe = 0;
  private strafeUntil = 0;
  /** A hit from out of view: turn toward where it came from (the HUD's damage indicator). */
  private hurtFrom: Vec3 | null = null;
  private hurtReactAt = Infinity;
  private lastHealth: number = PLAYER.maxHealth;

  constructor(
    seed: number,
    readonly profile: ReferenceProfile = REFERENCE_PLAYER,
  ) {
    this.rng = mulberry32(seed);
  }

  /** The HUD's damage indicator: the direction of the last hit taken. */
  hurt(from: Vec3, nowMs: number): void {
    this.hurtFrom = { ...from };
    this.hurtReactAt = nowMs + this.reaction();
  }

  decide(observation: BotObservation, own: Readonly<PlayerState>, dt: number): PlayerInput {
    const now = observation.nowMs;
    const self = observation.self;
    if (!this.initialized) {
      this.initialized = true;
      this.yaw = self.yaw;
      this.pitch = self.pitch;
    }
    if (self.health > this.lastHealth) this.hurtFrom = null;
    this.lastHealth = self.health;
    const target = this.pickTarget(observation.visiblePlayers, self.pos);
    let buttons = 0;
    let moveX = 0;
    let moveZ = 0;
    const gun = isGun(own.arsenal.slot) ? own.guns[own.arsenal.slot] : null;
    if (target) {
      this.lastSeenMs = now;
      this.lastSeenPos = { ...target.pos };
      this.hurtFrom = null;
      const d = Math.hypot(target.pos.x - self.pos.x, target.pos.z - self.pos.z);
      const aimPoint = this.perceived(now, this.aimPointOf(target));
      this.aimAt(now, self.eye, aimPoint, dt, d);
      if (d > 4) buttons |= Button.Ads;
      // A shimmering (spawn-protected) target can't be hurt, and a shot would end the player's
      // own protection for nothing: track it, hold fire until it is hittable.
      if (target.protected) this.burstLeft = 0;
      else buttons |= this.trigger(now, self.eye, aimPoint, d, own);
      const strafe = this.strafeFor(now);
      moveX = strafe;
      // Close the distance a little at long range (humans push toward mid range).
      if (d > 30) moveZ = 0.6;
    } else if (now - this.lastSeenMs < REACQUIRE_MS) {
      // Lost for a moment (a post, a strafe behind a crate edge): hold the aim, keep moving.
      this.burstLeft = 0;
      moveX = this.strafe;
    } else {
      this.targetId = null;
      this.tracking = false;
      this.flick = null;
      this.burstLeft = 0;
      this.idleAim(now, observation, dt);
      const goal = this.goal(observation);
      if (goal) {
        const steer = this.steerTo(self.pos, goal, observation);
        moveX = steer.x;
        moveZ = steer.z;
      }
      if (gun && gun.ammo < 12 && gun.reserve > 0) buttons |= Button.Reload;
    }
    if (gun && gun.ammo === 0 && gun.reserve > 0) buttons |= Button.Reload;
    // The crosshair the player sees includes the recoil kick; pull against what was seen.
    const comp = this.sprayComp(now, own);
    return sanitizeInput({
      ...emptyInput(observation.seq),
      moveX,
      moveZ,
      yaw: this.yaw + comp.yaw,
      pitch: this.pitch - comp.pitch,
      buttons,
    });
  }

  private pickTarget(visible: readonly BotVisiblePlayer[], from: Vec3): BotVisiblePlayer | null {
    if (!visible.length) return null;
    // Anyone hittable before a spawn-protected player (the shimmer everyone sees).
    const open = visible.filter((p) => !p.protected);
    const kept = visible.find((p) => p.id === this.targetId);
    if (kept && (!kept.protected || !open.length)) return kept;
    const choices = open.length ? open : visible;
    let best = choices[0]!;
    for (const p of choices) if (dist2(from, p.pos) < dist2(from, best.pos)) best = p;
    // A new target: react, then flick. One seen a moment ago is still being tracked.
    this.targetId = best.id;
    this.seen = [];
    this.aimHead = this.rng() < this.profile.headAimChance;
    this.control = Math.max(
      0,
      Math.min(0.95, this.profile.sprayControl + gauss(this.rng) * this.profile.sprayControlSd),
    );
    this.tracking = false;
    this.flick = null;
    this.reactAt = Infinity;
    return best;
  }

  private aimPointOf(t: BotVisiblePlayer): Vec3 {
    // Head sphere centre sits 3 cm over the eye; centre mass is the upper torso (eye - 0.45 m).
    const k = (t.eye.y - t.pos.y) / PLAYER.standEyeHeight;
    return { x: t.eye.x, y: this.aimHead ? t.eye.y + 0.03 * k : t.pos.y + 1.2 * k, z: t.eye.z };
  }

  /** Where the target appeared `trackLagMs` ago (humans track with a perceptual delay). */
  private perceived(now: number, p: Vec3): Vec3 {
    this.seen.push({ ms: now, p });
    const lagged = now - this.profile.trackLagMs;
    while (this.seen.length > 1 && this.seen[1]!.ms <= lagged) this.seen.shift();
    return this.seen[0]!.p;
  }

  private reaction(): number {
    const p = this.profile;
    return Math.max(150, p.reactionMs + gauss(this.rng) * p.reactionSdMs);
  }

  private aimAt(now: number, eye: Vec3, at: Vec3, dt: number, d: number): void {
    const p = this.profile;
    const want = anglesTo(eye, at);
    if (this.reactAt === Infinity && !this.tracking && !this.flick)
      this.reactAt = now + this.reaction();
    if (!this.tracking && !this.flick) {
      if (now < this.reactAt) return; // not reacted yet: the view stays where it was
      const dy = wrap(want.yaw - this.yaw);
      const dp = want.pitch - this.pitch;
      const angle = Math.hypot(dy, dp);
      const width = Math.atan2(TORSO_HALF_WIDTH * 2, Math.max(1, d));
      const bits = Math.log2(1 + angle / width);
      const gain = p.flickGain + gauss(this.rng) * p.flickGainSd;
      const gainP = p.flickGain + gauss(this.rng) * p.flickGainSd;
      // Endpoint error relative to the aim point: over/undershoot along the move plus a little
      // perpendicular scatter.
      const perp = gauss(this.rng) * angle * 0.04;
      this.flick = {
        startMs: now,
        durationMs: p.flickBaseMs + p.flickPerBitMs * bits,
        fromYaw: this.yaw,
        fromPitch: this.pitch,
        endErrYaw: dy * (gain - 1) + (angle > 0 ? (-dp / angle) * perp : 0),
        endErrPitch: dp * (gainP - 1) + (angle > 0 ? (dy / angle) * perp : 0),
      };
    }
    if (this.flick) {
      const f = this.flick;
      const s = Math.min(1, (now - f.startMs) / f.durationMs);
      const m = s * s * s * (10 - 15 * s + 6 * s * s); // minimum-jerk profile
      const endYaw = want.yaw + f.endErrYaw;
      const endPitch = want.pitch + f.endErrPitch;
      this.yaw = f.fromYaw + wrap(endYaw - f.fromYaw) * m;
      this.pitch = f.fromPitch + (endPitch - f.fromPitch) * m;
      if (s >= 1) {
        this.flick = null;
        this.tracking = true;
        this.errYaw = f.endErrYaw;
        this.errPitch = f.endErrPitch;
      }
      return;
    }
    // Corrective phase: the error decays, a tremor rides on top, the aim point is the lagged one.
    const decay = Math.exp((-dt * 1000) / p.settleTauMs);
    this.errYaw *= decay;
    this.errPitch *= decay;
    const tr = Math.exp((-dt * 1000) / p.tremorTauMs);
    const sd = p.tremorDeg * DEG * Math.sqrt(1 - tr * tr);
    this.tremorYaw = this.tremorYaw * tr + gauss(this.rng) * sd;
    this.tremorPitch = this.tremorPitch * tr + gauss(this.rng) * sd;
    this.yaw = want.yaw + this.errYaw + this.tremorYaw;
    this.pitch = want.pitch + this.errPitch + this.tremorPitch;
  }

  /** Full auto in bursts once the crosshair (recoil included) is on the body. */
  private trigger(now: number, eye: Vec3, at: Vec3, d: number, own: Readonly<PlayerState>): number {
    const p = this.profile;
    const slot = own.arsenal.slot;
    if (!isGun(slot) || (!this.tracking && !this.nearEndOfFlick(now))) return 0;
    const gun = own.guns[slot];
    if (gun.ammo <= 0 || gun.reloadTimer > 0) {
      this.burstLeft = 0;
      return 0;
    }
    const want = anglesTo(eye, at);
    // What the crosshair shows: the view plus the recoil kick (less what was already pulled).
    const comp = this.sprayComp(now, own);
    const shownYaw = this.yaw + comp.yaw - gun.recoilYaw * DEG;
    const shownPitch = this.pitch - comp.pitch + gun.recoilPitch * DEG;
    const err = Math.hypot(wrap(shownYaw - want.yaw), shownPitch - want.pitch);
    const tolerance = Math.atan2(TORSO_HALF_WIDTH * p.fireTolerance, Math.max(1, d));
    const cfg = gunConfig(own.arsenal, slot);
    if (this.burstLeft > 0) {
      // Let go when the spray has clearly walked off the body.
      if (err > tolerance * 3.5) {
        this.endBurst(now);
        return 0;
      }
      if (gun.shotCounter - this.burstStartShots >= this.burstLeft) {
        this.endBurst(now);
        return 0;
      }
      return Button.Fire;
    }
    if (now < this.nextBurstAt || err > tolerance) return 0;
    const close = d < 10;
    const lo = close ? p.closeBurstMin : p.burstMin;
    const hi = close ? p.closeBurstMax : p.burstMax;
    this.burstLeft = cfg.semiAuto ? 1 : lo + Math.floor(this.rng() * (hi - lo + 1));
    this.burstStartShots = gun.shotCounter;
    return Button.Fire;
  }

  private nearEndOfFlick(now: number): boolean {
    const f = this.flick;
    return f !== null && now - f.startMs >= f.durationMs * 0.85;
  }

  private endBurst(now: number): void {
    const p = this.profile;
    this.burstLeft = 0;
    this.nextBurstAt = now + p.burstPauseMs + this.rng() * p.burstPauseJitterMs;
  }

  /** The part of the recoil kick the player has seen and pulled against (radians). */
  private sprayComp(now: number, own: Readonly<PlayerState>): { yaw: number; pitch: number } {
    const slot = own.arsenal.slot;
    const gun = isGun(slot) ? own.guns[slot] : null;
    this.recoilSeen.push({ ms: now, pitch: gun?.recoilPitch ?? 0, yaw: gun?.recoilYaw ?? 0 });
    const lagged = now - this.profile.sprayLagMs;
    while (this.recoilSeen.length > 1 && this.recoilSeen[1]!.ms <= lagged) this.recoilSeen.shift();
    const r = this.recoilSeen[0]!;
    return { yaw: r.yaw * this.control * DEG, pitch: r.pitch * this.control * DEG };
  }

  private strafeFor(now: number): number {
    const p = this.profile;
    if (now >= this.strafeUntil) {
      this.strafeUntil = now + p.strafeMinMs + this.rng() * p.strafeJitterMs;
      this.strafe =
        this.rng() < p.strafeChance ? (this.rng() < 0.5 ? -p.strafeSpeed : p.strafeSpeed) : 0;
    }
    return this.strafe;
  }

  /** No one in view: look where the threat was (or came from), else along the way ahead. */
  private idleAim(now: number, observation: BotObservation, dt: number): void {
    const eye = observation.self.eye;
    let look: Vec3 | null = null;
    if (this.hurtFrom && now >= this.hurtReactAt) look = this.hurtFrom;
    else if (this.lastSeenPos && now - this.lastSeenMs < this.profile.memoryMs)
      look = { ...this.lastSeenPos, y: this.lastSeenPos.y + PLAYER.standEyeHeight };
    if (!look) return;
    const want = anglesTo(eye, look);
    // A deliberate turn (not a flick at a target): ~ 360°/s, like a mouse swipe.
    const step = 6.3 * dt;
    this.yaw += clamp(wrap(want.yaw - this.yaw), -step, step);
    this.pitch += clamp(want.pitch - this.pitch, -step, step);
    if (Math.abs(wrap(want.yaw - this.yaw)) < 0.05 && look === this.hurtFrom) this.hurtFrom = null;
  }

  private wanderGoal: Vec3 | null = null;
  private wanderUntil = 0;
  private path: readonly Vec3[] = [];
  private pathGoal: Vec3 | null = null;

  /** Chase the last sighting, else roam the map (a human knows the layout: the nav graph). */
  private goal(observation: BotObservation): Vec3 | null {
    const now = observation.nowMs;
    if (this.lastSeenPos && now - this.lastSeenMs < this.profile.memoryMs) {
      if (dist2(observation.self.pos, this.lastSeenPos) > 2) return this.lastSeenPos;
      this.lastSeenPos = null;
    }
    const nodes = observation.nav.wanderNodes;
    if (!nodes.length) return null;
    if (
      !this.wanderGoal ||
      now >= this.wanderUntil ||
      dist2(observation.self.pos, this.wanderGoal) < observation.nav.cellSize
    ) {
      const n = nodes[Math.floor(this.rng() * nodes.length)]!;
      this.wanderGoal = { x: n.x, y: n.y, z: n.z };
      this.wanderUntil = now + 6000 + this.rng() * 4000;
    }
    return this.wanderGoal;
  }

  private steerTo(pos: Vec3, goal: Vec3, observation: BotObservation): { x: number; z: number } {
    const graph = observation.nav;
    if (!this.pathGoal || dist2(this.pathGoal, goal) > graph.cellSize) {
      this.path = graph.route(pos, goal).points;
      this.pathGoal = { ...goal };
    }
    let waypoint = this.path[0] ?? goal;
    while (this.path.length && dist2(pos, waypoint) < graph.cellSize * 0.45) {
      this.path = this.path.slice(1);
      waypoint = this.path[0] ?? goal;
    }
    const dx = waypoint.x - pos.x;
    const dz = waypoint.z - pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.4) return { x: 0, z: 0 };
    // Walking: the view turns toward the way ahead (unless watching a threat, see idleAim).
    if (!(this.hurtFrom || (this.lastSeenPos && this.lastSeenMs > observation.nowMs - 1500))) {
      const wantYaw = Math.atan2(-dx, -dz);
      this.yaw += clamp(wrap(wantYaw - this.yaw), -0.08, 0.08);
      this.pitch *= 0.9;
    }
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    return { x: (rx * dx + rz * dz) / len, z: (fx * dx + fz * dz) / len };
  }
}

function anglesTo(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

function wrap(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function dist2(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Standard normal sample (Box–Muller). */
export function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}
