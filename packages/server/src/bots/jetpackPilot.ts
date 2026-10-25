import { Button, hashSeed, JetMode, type BotPersonalityId, type Vec3 } from '@wd/shared';
import type { BotObservation, BotVisiblePlayer } from './types.ts';

/**
 * How keen each personality is on a jetpack (Kiran: rushers and flankers go for them; the
 * personality decides): the chance a bot decides a given free pack is worth the detour, and how
 * far it goes for one (m). The plain tree (no personality) is lukewarm.
 */
export const JETPACK_BOT = {
  keen: { rusher: 1, flanker: 0.9, marksman: 0.45, anchor: 0.25 } as Record<
    BotPersonalityId,
    number
  >,
  baselineKeen: 0.5,
  seekRadius: 38,
  /** Mid-fight, only a pack this close is worth grabbing (m). */
  fightGrabRadius: 8,
  /** Light it to fight a target at least this far (m), or to hunt a memory. */
  igniteRange: 9,
  /** Cruise height above the ground (m), under the ceiling. */
  cruiseAlt: 3.6,
  /** Hold this far from a target while strafing in the air (m)… */
  standoff: 11,
  /** …and come down near it when the window runs low (s left) or it is this close (m). */
  landFuel: 4,
  landRange: 6,
  /**
   * Breaking line (lead, 2026-10-03: flyers died too easily): when hit, or aimed at by a visible
   * enemy for this long (ms), a flyer jukes sideways and drops toward the nearest spot out of
   * that enemy's sight for `evadeMs`, then resumes; not again for `evadeCooldownMs`.
   */
  aimedMs: 600,
  /** "Aimed at": the enemy's view within this of the line to our eye (rad). */
  aimCone: 0.09,
  evadeMs: 1400,
  /** Below this health a flyer gets down into cover and fights from the ground. */
  retreatHealth: 55,
  evadeCooldownMs: 1200,
  /** Where to look for cover (m) when breaking line. */
  coverRadius: 12,
  /** Cruise heights tried (m above the ground): the one fewest known enemies can see wins. */
  cruiseOptions: [1.3, 2.4, 3.6] as readonly number[],
  /** How often the cruise height is re-chosen (ms). */
  cruiseEveryMs: 300,
} as const;

/**
 * The bots' jetpack brain, inside the behaviour tree (`BehaviorTreeDecisionProvider`): pure
 * decisions over the observation, producing ordinary `PlayerInput` buttons and stick — the same
 * input path a player has. It draws no numbers from the tree's random stream (decisions hash the
 * bot's seed), so trees without jetpacks around (skill duels) are unchanged.
 */
export class JetpackPilot {
  /** Lighting sequence: ticks since the ground jump (−1: not lighting). */
  private lighting = -1;
  private lastHealth = -1;
  private lastMs = -1;
  private aimedFor = 0;
  private evadeUntil = 0;
  private evadeReadyAt = 0;
  private evadeGoal: Vec3 | null = null;
  private evadeSide = 1;
  private cruise: number = JETPACK_BOT.cruiseAlt;
  private cruiseAt = 0;

  constructor(
    private readonly seed: number,
    private readonly persona: BotPersonalityId | null,
  ) {}

  private get keen(): number {
    return this.persona ? JETPACK_BOT.keen[this.persona] : JETPACK_BOT.baselineKeen;
  }

  /** A free pack worth walking to (nearest wanted one in reach), when wearing none. */
  packGoal(o: BotObservation, radius: number = JETPACK_BOT.seekRadius): Vec3 | null {
    if ((o.self.jet ?? 0) !== JetMode.None || !o.jetpacks?.length) return null;
    let best: Vec3 | null = null;
    let bestD = radius;
    for (const p of o.jetpacks) {
      const want = (hashSeed(this.seed, p.id, 0x7e7) % 1000) / 1000 < this.keen;
      if (!want) continue;
      const d = Math.hypot(p.pos.x - o.self.pos.x, p.pos.z - o.self.pos.z);
      if (d < bestD && Math.abs(p.pos.y - o.self.pos.y) < 3) {
        best = p.pos;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * Overrides for this tick: light a worn pack when there is a fight to take height for (a
   * target at range, or a memory to flank onto); in flight, fly straight at the goal (not by
   * the nav graph: over the stalls), hold the cruise height, strafe and keep the tree's aim and
   * trigger, and come down near the target. Null: the tree's own input stands.
   */
  adjust(
    o: BotObservation,
    target: BotVisiblePlayer | null,
    goal: Vec3 | null,
    yaw: number,
    strafe: number,
    buttons: number,
  ): { moveX?: number; moveZ?: number; buttons: number } | null {
    const self = o.self;
    // The clock runs every tick (lit or not): the aimed-at timer must never count unlit time.
    const now = o.nowMs;
    const dtMs = this.lastMs < 0 ? 16 : Math.max(0, now - this.lastMs);
    this.lastMs = now;
    if (self.jet === JetMode.Worn) {
      this.aimedFor = 0;
      const d = target ? Math.hypot(target.pos.x - self.pos.x, target.pos.z - self.pos.z) : 0;
      const fight =
        (target !== null && !target.protected && d > JETPACK_BOT.igniteRange) ||
        (target === null && goal !== null && o.memories.length > 0);
      const keenNow = (hashSeed(this.seed, Math.floor(o.nowMs / 2000)) % 1000) / 1000 < this.keen;
      if (this.lighting < 0 && fight && keenNow && self.grounded === true) this.lighting = 0;
      if (this.lighting < 0) return null;
      const t = this.lighting++;
      // Jump, let go, Jump again near the top: lit (the tree keeps steering meanwhile).
      const press = t === 0 || t === 10;
      if (t > 14) this.lighting = -1;
      return {
        buttons:
          (buttons & ~(Button.Jump | Button.Sprint | Button.Crouch)) | (press ? Button.Jump : 0),
      };
    }
    this.lighting = -1;
    const hurt = this.lastHealth >= 0 && self.health < this.lastHealth;
    this.lastHealth = self.health;
    if (self.jet !== JetMode.Flying) {
      this.aimedFor = 0;
      this.evadeUntil = 0;
      return null;
    }
    // Who is aiming at us right now (their view along the line to our eye), the nearest first.
    let aimer: BotVisiblePlayer | null = null;
    for (const p of o.visiblePlayers) {
      if (aimingAt(p, self.eye) && (!aimer || dist2(p.pos, self.pos) < dist2(aimer.pos, self.pos)))
        aimer = p;
    }
    this.aimedFor = aimer ? this.aimedFor + dtMs : 0;
    // Badly hurt and down on the ground (landed with fuel left): stay down, walking where the
    // tree steers (to cover, a medkit) — no cruise climb, which hopped it back up again and again.
    if (self.health < JETPACK_BOT.retreatHealth && self.grounded === true) {
      this.evadeUntil = 0;
      return { buttons: buttons & ~(Button.Jump | Button.Sprint) };
    }
    // Badly hurt in the air: keep breaking line (down into cover) until on the ground.
    const hurtBad = self.health < JETPACK_BOT.retreatHealth && !self.grounded;
    if (
      (now >= this.evadeReadyAt || hurtBad) &&
      now >= this.evadeUntil &&
      (hurt || hurtBad || this.aimedFor > JETPACK_BOT.aimedMs)
    ) {
      const threat = aimer ?? target ?? nearestVisible(o);
      this.evadeUntil = now + JETPACK_BOT.evadeMs;
      this.evadeReadyAt = this.evadeUntil + JETPACK_BOT.evadeCooldownMs;
      this.evadeSide = -this.evadeSide;
      this.evadeGoal = threat ? coverFrom(o, threat.eye) : null;
      this.aimedFor = 0;
    }
    if (now < this.evadeUntil) {
      // Break line: sideways (alternating) and toward cover, dropping the whole way.
      const threat = aimer ?? target;
      let wx = 0;
      let wz = 0;
      if (threat) {
        const dx = self.pos.x - threat.pos.x;
        const dz = self.pos.z - threat.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        wx = (-dz / d) * this.evadeSide;
        wz = (dx / d) * this.evadeSide;
      }
      const g = this.evadeGoal;
      if (g) {
        const gx = g.x - self.pos.x;
        const gz = g.z - self.pos.z;
        const gd = Math.hypot(gx, gz);
        if (gd > 0.6) {
          wx = wx * 0.4 + (gx / gd) * 0.9;
          wz = wz * 0.4 + (gz / gd) * 0.9;
        }
      }
      return {
        ...toStick(wx, wz, yaw),
        buttons: (buttons & ~(Button.Jump | Button.Sprint | Button.Crouch)) | Button.Crouch,
      };
    }
    // Cruise at the height the fewest known enemies can see (a roof or a container between).
    if (now >= this.cruiseAt) {
      this.cruiseAt = now + JETPACK_BOT.cruiseEveryMs;
      this.cruise = coveredCruise(o, target);
    }
    const at = target?.pos ?? goal;
    let wx = 0;
    let wz = 0;
    let land = (self.jetFuel ?? 0) < JETPACK_BOT.landFuel;
    if (at) {
      const dx = at.x - self.pos.x;
      const dz = at.z - self.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      if (target) {
        // In and around: close to the standoff, circle it there.
        const close = d - JETPACK_BOT.standoff;
        const radial = Math.max(-1, Math.min(1, close / 4));
        wx = (dx / d) * radial + (-dz / d) * (strafe || 0.6);
        wz = (dz / d) * radial + (dx / d) * (strafe || 0.6);
        if (d < JETPACK_BOT.landRange) land = true;
      } else {
        wx = dx / d;
        wz = dz / d;
      }
    }
    const alt = self.jetAlt ?? 0;
    let vertical = 0;
    if (land || alt > this.cruise + 0.5) vertical = Button.Crouch;
    else if (alt < this.cruise - 0.25) vertical = Button.Jump;
    return {
      ...toStick(wx, wz, yaw),
      buttons: (buttons & ~(Button.Jump | Button.Sprint | Button.Crouch)) | vertical,
    };
  }

  reset(): void {
    this.lighting = -1;
    this.lastHealth = -1;
    this.lastMs = -1;
    this.aimedFor = 0;
    this.evadeUntil = 0;
  }
}

/** World direction → stick, relative to the view (as the tree's `steer` does). */
function toStick(wx: number, wz: number, yaw: number): { moveX: number; moveZ: number } {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let moveX = rx * wx + rz * wz;
  let moveZ = fx * wx + fz * wz;
  const len = Math.hypot(moveX, moveZ);
  if (len > 1) {
    moveX /= len;
    moveZ /= len;
  }
  return { moveX, moveZ };
}

const dist2 = (a: Vec3, b: Vec3): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

/** Is this player's view pointed at `eye` (within `aimCone`)? What a player sees: a muzzle on you. */
function aimingAt(p: BotVisiblePlayer, eye: Vec3): boolean {
  const dx = eye.x - p.eye.x;
  const dy = eye.y - p.eye.y;
  const dz = eye.z - p.eye.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-3) return false;
  const cp = Math.cos(p.pitch);
  const vx = -Math.sin(p.yaw) * cp;
  const vy = Math.sin(p.pitch);
  const vz = -Math.cos(p.yaw) * cp;
  return (vx * dx + vy * dy + vz * dz) / d > Math.cos(JETPACK_BOT.aimCone);
}

function nearestVisible(o: BotObservation): BotVisiblePlayer | null {
  let best: BotVisiblePlayer | null = null;
  for (const p of o.visiblePlayers)
    if (!best || dist2(p.pos, o.self.pos) < dist2(best.pos, o.self.pos)) best = p;
  return best;
}

/** The nearest nav spot within `coverRadius` that `threatEye` can't see (a standing eye). */
function coverFrom(o: BotObservation, threatEye: Vec3): Vec3 | null {
  const nav = o.nav;
  const r2 = JETPACK_BOT.coverRadius ** 2;
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (const n of nav.nodes) {
    const d = dist2(n, o.self.pos);
    if (d > r2 || d >= bestD || d < 1) continue;
    if (nav.lineOfSight(threatEye, { x: n.x, y: n.y + 1.6, z: n.z })) continue;
    best = { x: n.x, y: n.y, z: n.z };
    bestD = d;
  }
  return best;
}

/**
 * The cruise height (m above the ground) the fewest known enemies other than the one we fight can
 * see us at — remembered positions included — preferring the higher on a tie (it shoots over
 * cover). Without known enemies: the plain cruise height.
 */
function coveredCruise(o: BotObservation, target: BotVisiblePlayer | null): number {
  const eyes: Vec3[] = [];
  for (const p of o.visiblePlayers) if (p.id !== target?.id) eyes.push(p.eye);
  for (const m of o.memories)
    if (m.id !== target?.id && !o.visiblePlayers.some((p) => p.id === m.id))
      eyes.push({ x: m.pos.x, y: m.pos.y + 1.62, z: m.pos.z });
  if (!eyes.length) return JETPACK_BOT.cruiseAlt;
  const ground = o.self.pos.y - (o.self.jetAlt ?? 0);
  let best: number = JETPACK_BOT.cruiseAlt;
  let bestSeen = Infinity;
  for (const h of [...JETPACK_BOT.cruiseOptions].reverse()) {
    const me = { x: o.self.pos.x, y: ground + h + 1.62, z: o.self.pos.z };
    let seen = 0;
    for (const e of eyes) if (o.nav.lineOfSight(e, me)) seen++;
    if (seen < bestSeen) {
      best = h;
      bestSeen = seen;
    }
  }
  return best;
}

/** A free pack in the observation. */
export interface ObservedJetpack {
  readonly id: number;
  readonly pos: Vec3;
}
