import {
  Button,
  clonePlayerState,
  createPlayerState,
  eyePosition,
  horizontalSpeed,
  isSpawnProtected,
  JAMMER,
  KNIFE,
  PLAYER,
  stepPlayerInCrowd,
  type CrowdMember,
  type PhysicsWorld,
  type PlayerEvent,
  type PlayerInput,
  type PlayerState,
  type RapierCharacter,
  type Vec3,
} from '@wd/shared';

/** Seconds between the partner's radar-style pings on a hidden opponent. */
const PING_INTERVAL = 3;

/**
 * Knife sparring partner for the range. It is a *bot on the real input path*: it owns a normal
 * PlayerState, produces a PlayerInput every sim step, and runs through the same `stepPlayer` as
 * the human — exactly how M3/M6 bots will drive players on the server. Only its brain (below) is
 * specific to sparring.
 */
export class SparringPartner {
  state: PlayerState;
  prev: PlayerState;
  private readonly body: RapierCharacter;
  private seq = 0;
  private respawnTimer = 0;
  // Brain
  private strafeDir = 1;
  private strafeTimer = 0;
  private attackCooldown = 1.5;
  private attackHold = 0;
  private backoff = 0;
  private reactTimer = -1;
  private guardHold = 0;
  /** Chasing but not closing in (blocked by cover): time stuck, and an active detour. */
  private stuckFor = 0;
  private detour = 0;
  private detourDir = 1;
  /**
   * Perception: the partner only knows where you are when it can see you (walls, smoke and
   * foliage hide you, same as from a human). Out of sight it hunts your last known spot, helped
   * by a radar-style ping every few seconds — which a jammer pulse knocks out.
   */
  private lastKnown: Vec3 | null = null;
  private pingTimer = 0;
  private jammed = 0;
  /** Whether the opponent was in sight on the last step (gates reading their tells). */
  private seesOpponent = false;

  private readonly spawn: Vec3;

  constructor(
    physics: PhysicsWorld,
    /** Finds a collision-free standing spot near a point (spawn/respawn safety). */
    private readonly clearSpot: (near: Vec3) => Vec3,
    preferred: Vec3,
  ) {
    this.spawn = clearSpot(preferred);
    this.state = createPlayerState(this.spawn, 7, 'knife');
    this.prev = clonePlayerState(this.state);
    this.body = physics.createCharacter(this.spawn);
  }

  get alive(): boolean {
    return this.state.health > 0;
  }

  /** The human started a strike: sometimes read the chamber and raise the guard in time. */
  onOpponentChamber(opponentPos: Vec3): void {
    // Reading a chamber needs eyes on the attacker (smoke/cover hide the tell too).
    if (!this.alive || this.reactTimer >= 0 || !this.seesOpponent) return;
    const d = Math.hypot(
      opponentPos.x - this.state.move.pos.x,
      opponentPos.z - this.state.move.pos.z,
    );
    if (d < 3.2 && Math.random() < 0.4) this.reactTimer = 0.14 + Math.random() * 0.08;
  }

  /** Hit by the opponent's jammer: no radar pings for a while. */
  jam(): void {
    this.jammed = JAMMER.radarJam;
  }

  get isJammed(): boolean {
    return this.jammed > 0;
  }

  private brain(dt: number, target: PlayerState, sees: boolean): PlayerInput {
    const me = this.state.move.pos;
    this.seesOpponent = sees;
    this.jammed = Math.max(0, this.jammed - dt);
    this.pingTimer -= dt;
    if (sees) {
      this.lastKnown = { ...target.move.pos };
      // Losing sight starts a full ping interval: the first guess is the last *seen* spot.
      this.pingTimer = PING_INTERVAL;
    } else if (this.pingTimer <= 0 && this.jammed <= 0) {
      this.lastKnown = { ...target.move.pos };
      this.pingTimer = PING_INTERVAL;
    }
    const t = this.lastKnown ?? me;
    const dx = t.x - me.x;
    const dz = t.z - me.z;
    const dist = Math.hypot(dx, dz);
    const yaw = Math.atan2(-dx, -dz); // face the opponent (yaw 0 = -Z)
    const dy = t.y + target.move.eyeHeight * 0.75 - (me.y + this.state.move.eyeHeight);
    const pitch = Math.atan2(dy, Math.max(0.5, dist));
    let moveX = 0;
    let moveZ: number;
    let buttons = 0;

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      this.strafeTimer = 0.8 + Math.random() * 0.8;
    }
    this.attackCooldown -= dt;
    this.backoff = Math.max(0, this.backoff - dt);

    // Defensive read of the opponent's chamber.
    if (this.reactTimer >= 0) {
      this.reactTimer -= dt;
      if (this.reactTimer < 0) this.guardHold = 0.45;
    }
    if (dist < 1.1) {
      // Too close to fight well: step back out to knife range (no body collision yet).
      moveZ = -1;
      moveX = this.strafeDir * 0.4;
      if (this.guardHold > 0) buttons |= Button.Block;
      this.guardHold = Math.max(0, this.guardHold - dt);
      if (this.attackHold > 0) {
        this.attackHold -= dt;
        buttons |= Button.Fire;
      }
    } else if (this.guardHold > 0) {
      this.guardHold -= dt;
      buttons |= Button.Block;
      moveZ = -0.3;
    } else if (this.attackHold > 0) {
      // Committed combo: keep pressing forward and slashing.
      this.attackHold -= dt;
      buttons |= Button.Fire;
      moveZ = dist > 1.6 ? 0.6 : 0;
      if (this.attackHold <= 0) this.backoff = 0.6;
    } else if (this.backoff > 0) {
      moveZ = -1;
      moveX = this.strafeDir * 0.5;
    } else if (dist > 2.3) {
      // Chase. No navmesh yet (that comes with the M3 bots): if cover stops us closing in,
      // sidestep along it (hopping in case it's low), alternating sides until we get around.
      const v = this.state.move.vel;
      this.stuckFor = Math.hypot(v.x, v.z) < 1 && this.detour <= 0 ? this.stuckFor + dt : 0;
      if (this.stuckFor > 0.4) {
        this.detour = 1.2;
        this.detourDir = -this.detourDir;
        this.stuckFor = 0;
        buttons |= Button.Jump;
      }
      if (this.detour > 0) {
        this.detour -= dt;
        moveX = this.detourDir;
        moveZ = 0.3;
      } else {
        moveZ = 1;
        if (dist > 6) buttons |= Button.Sprint;
      }
    } else if (!sees) {
      // At the last known spot but the opponent is hidden (smoke, cover): search, don't swing.
      moveX = this.strafeDir * 0.6;
      moveZ = 0;
    } else {
      moveX = this.strafeDir * 0.7;
      moveZ = dist > 1.8 ? 0.3 : -0.2;
      // A spawn-protected opponent can't be hurt yet: circle, don't waste the combo.
      if (this.attackCooldown <= 0 && this.state.arsenal.stun <= 0 && !isSpawnProtected(target)) {
        const strikes = 1 + Math.floor(Math.random() * 3);
        // Hold long enough for the opening chamber plus the follow-ups.
        this.attackHold =
          KNIFE.openingWindup + (strikes - 1) * (KNIFE.windup + KNIFE.recovery) + 0.05;
        this.attackCooldown = 1.4 + Math.random() * 1.4;
      }
    }
    return { seq: this.seq++, moveX, moveZ, yaw, pitch, buttons };
  }

  /** One fixed sim step. Returns the partner's events (tells, strikes, footsteps). */
  step(
    dt: number,
    target: PlayerState,
    opponentAlive: boolean,
    sees: boolean,
    crowd?: readonly CrowdMember[],
  ): PlayerEvent[] {
    this.prev = clonePlayerState(this.state);
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(target);
      return [];
    }
    const input = opponentAlive
      ? this.brain(dt, target, sees)
      : { seq: this.seq++, moveX: 0, moveZ: 0, yaw: this.state.view.yaw, pitch: 0, buttons: 0 };
    return stepPlayerInCrowd(this.state, input, dt, this.body, crowd, 'partner');
  }

  /** Called when the partner's health hits zero. */
  died(): void {
    this.respawnTimer = 3;
  }

  private respawn(target: PlayerState): void {
    // Come back ~12 m from the opponent (nearest free spot on their level).
    const t = target.move.pos;
    const s = this.clearSpot({ x: t.x, y: t.y, z: t.z - 12 });
    this.body.setPosition(s);
    this.state = createPlayerState(s, 7, 'knife');
    this.prev = clonePlayerState(this.state);
    this.attackCooldown = 2;
    // Fresh brain: nothing carried over from the life that just ended.
    this.attackHold = 0;
    this.guardHold = 0;
    this.backoff = 0;
    this.reactTimer = -1;
    this.stuckFor = 0;
    this.detour = 0;
    this.lastKnown = null;
    this.pingTimer = 0;
    this.jammed = 0;
    this.seesOpponent = false;
  }

  eye(): Vec3 {
    return eyePosition(this.state);
  }

  get speed(): number {
    return horizontalSpeed(this.state.move);
  }

  static readonly MAX_HEALTH = PLAYER.maxHealth;

  dispose(): void {
    this.body.free();
  }
}
