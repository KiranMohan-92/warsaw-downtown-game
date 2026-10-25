import {
  BOT,
  Button,
  DRONE,
  KNIFE,
  PLAYER,
  TAC_SPRINT,
  emptyInput,
  gunConfig,
  hashSeed,
  mulberry32,
  sanitizeInput,
  type BotGunProfile,
  type BotPersonality,
  type PlayerInput,
  type Vec3,
} from '@wd/shared';
import type { NavGraph } from './nav.ts';
import { VehicleBrain, type VehiclePlan } from './vehicleBrain.ts';
import { JETPACK_BOT, JetpackPilot } from './jetpackPilot.ts';
import type {
  BotConfig,
  BotMemory,
  BotObservation,
  BotVisibleTarget,
  DecisionProvider,
} from './types.ts';

type BotMode = 'engage' | 'seek' | 'cover';

export class BehaviorTreeDecisionProvider implements DecisionProvider {
  private rng: () => number;
  private initialized = false;
  private yaw = 0;
  private pitch = 0;
  private desiredYaw = 0;
  private desiredPitch = 0;
  private strafe = 0;
  private strafeUntil = 0;
  private nextFireAt = 0;
  /** Holding a coilgun charge / letting an energy gun cool (see `trigger`). */
  private charging = false;
  private venting = false;
  /** Rounds fired in the current full-auto burst. */
  private burst = 0;
  private nextGrenadeAt = 0;
  /** The slot button pressed last tick (0 = none): released for a tick to re-press (`equip`). */
  private slotPressed = 0;
  private nextReactAt = 0;
  private acquiredTargetId: string | null = null;
  private acquiredReadyAt = Infinity;
  /** The target the aim has settled onto since it was acquired (see `aimAtTarget`). */
  private settledFor: string | null = null;
  /** Aim error left from the acquisition (rad), decaying over `settleMs`. */
  private settleYaw = 0;
  private settlePitch = 0;
  /** Steady aim error (rad), redrawn every reaction interval (`aimError`). */
  private jitterYaw = 0;
  private jitterPitch = 0;
  /** This engagement aims at the head (`headAimChance`), else centre mass. */
  private aimHead = false;
  /** Where the target was lately (aim point, ms): the aim follows it `trackLagMs` behind. */
  private tracked: { ms: number; p: Vec3 }[] = [];
  /** The crosshair (recoil kick included) is on the target's body this tick. */
  private onTarget = false;
  private currentTarget: string | null = null;
  private path: readonly Vec3[] = [];
  private pathGoal: Vec3 | null = null;
  private pathComplete = true;
  private wanderGoal: Vec3 | null = null;
  private wanderUntil = 0;
  private coverGoal: Vec3 | null = null;
  private coverThreat: Vec3 | null = null;
  private coverUntil = 0;
  private progressPos: Vec3 | null = null;
  private progressAt = 0;
  private unstickUntil = 0;
  private unstickMove: { x: number; z: number; jump: boolean } = { x: 0, z: 0, jump: false };
  private lastPos: Vec3 | null = null;
  private readonly memories = new Map<string, BotMemory>();
  /** How this bot plays (`BOT.personalities`), null for the plain baseline. */
  private readonly persona: BotPersonality | null;
  /** TacSprint was pressed last tick (released for a tick: each burst needs a fresh edge). */
  private tacPressed = false;
  /** Holding a spot (anchor / marksman with nobody to hunt) until then (ms), and where. */
  private holdUntil = 0;
  private heldGoal: Vec3 | null = null;
  private holdYaw = 0;
  /** The side point a flanker heads for before turning in on `flankFor`. */
  private flankGoal: Vec3 | null = null;
  private flankFor: Vec3 | null = null;
  private flankSide = 1;
  /** This engagement is fought crouched (`crouchFire`). */
  private crouchEngage = false;
  /** Riding and driving the trucks (its own random stream: no trucks, no change). */
  private readonly vehicles: VehicleBrain;
  /** Going for jetpacks, lighting them and flying (`jetpackPilot.ts`; draws no tree randoms). */
  private readonly jet: JetpackPilot;

  constructor(readonly config: BotConfig) {
    this.rng = mulberry32(config.seed);
    this.nextGrenadeAt = 2000 + this.rng() * 5000;
    this.persona = config.personality ? BOT.personalities[config.personality] : null;
    this.flankSide = hashSeed(config.seed, 0xf1a) % 2 === 0 ? 1 : -1;
    this.vehicles = new VehicleBrain(config.seed, this.persona);
    this.jet = new JetpackPilot(config.seed, config.personality ?? null);
  }

  decide(observation: BotObservation, dt: number): PlayerInput {
    this.initializeAim(observation);
    this.observe(observation);
    const graph = observation.nav;
    const target = this.pickTarget(observation);
    const playerTarget = target?.kind === 'drone' ? null : target;
    this.updateAcquisition(observation, target);
    // A bot on a lit jetpack flies it and never boards (the sim ignores Interact in the air).
    const flying = (observation.self.jet ?? 0) >= 2;
    const vplan =
      !flying && (observation.vehicles?.length || observation.self.seat)
        ? this.vehicles.plan(observation, playerTarget, this.nearestMemory(observation))
        : null;
    if (vplan?.kind === 'drive') return this.driveInput(observation, vplan, dt);
    const mode = this.mode(observation, target);
    const goal =
      vplan?.kind === 'walk' && mode !== 'cover'
        ? vplan.goal
        : this.goal(observation, target, mode);
    const aim = target
      ? this.aimAtTarget(observation, target, dt)
      : this.aim(
          observation,
          goal ?? this.holdLook(observation) ?? this.wanderPoint(observation, graph),
          dt,
        );
    let buttons = this.buttons(observation, target, mode, goal);
    // Precision guns plant to shoot: their moving spread wastes every round.
    const planted = mode === 'engage' && target !== null && this.planted(observation, target);
    if (planted) this.progressPos = null; // standing still on purpose is not being stuck
    const baseSteering =
      goal && !planted
        ? this.steer(observation.self.pos, goal, graph, observation.nowMs)
        : { x: 0, z: 0 };
    let steering =
      target && !planted && (mode === 'engage' || mode === 'cover')
        ? normalizeInput({ x: baseSteering.x + this.strafe, z: baseSteering.z })
        : baseSteering;
    if (this.unstickMove.jump && observation.nowMs < this.unstickUntil) buttons |= Button.Jump;
    if (vplan?.interact) buttons |= Button.Interact;
    // A passenger's seat holds it: the sticks do nothing (the hands shoot from the seat).
    const seated = vplan?.kind === 'ride';
    // A worn jetpack: light it for a fight; in flight, fly it (the same buttons a player has).
    // The pilot sees what the tree remembers (live observations carry no memories of their own),
    // and only players the tree would fight: in hunt-humans other bots light nothing.
    // Seated bots never fly (the seat holds them; a rider can't ignite).
    const jet =
      seated || observation.self.seat
        ? null
        : this.jet.adjust(
            this.pilotView(observation),
            playerTarget,
            goal,
            aim.yaw,
            this.strafe,
            buttons,
          );
    if (jet) {
      buttons = jet.buttons;
      if (jet.moveX !== undefined && jet.moveZ !== undefined)
        steering = { x: jet.moveX, z: jet.moveZ };
    }
    return sanitizeInput({
      ...emptyInput(observation.seq),
      moveX: seated ? 0 : steering.x,
      moveZ: seated ? 0 : steering.z,
      yaw: aim.yaw,
      pitch: aim.pitch,
      buttons,
    });
  }

  /** At the wheel: the plan's sticks, looking down the road (or at whoever is being rammed). */
  private driveInput(
    observation: BotObservation,
    plan: Extract<VehiclePlan, { kind: 'drive' }>,
    dt: number,
  ): PlayerInput {
    this.progressPos = null; // the truck's own unstick handles getting stuck
    const look = this.aim(observation, { ...plan.look, y: observation.self.eye.y }, dt);
    return sanitizeInput({
      ...emptyInput(observation.seq),
      moveX: plan.moveX,
      moveZ: plan.moveZ,
      yaw: look.yaw,
      pitch: look.pitch,
      buttons: (plan.handbrake ? Button.Jump : 0) | (plan.interact ? Button.Interact : 0),
    });
  }

  readonly debug = {
    memories: (): readonly BotMemory[] => [...this.memories.values()],
    /** Where it is roaming to (null before it picked a spot). */
    wanderGoal: (): Vec3 | null => (this.wanderGoal ? { ...this.wanderGoal } : null),
    vehicle: (): { reason: string; routeLength: number } => ({ ...this.vehicles.debug }),
  };

  /** May this bot fight that player? The one target policy (targets, memories, the pilot). */
  private eligible(p: { readonly isBot: boolean }): boolean {
    return this.config.behavior === 'hunt-humans' ? !p.isBot : true;
  }

  /**
   * The observation as the jetpack pilot sees it: the tree's memories merged in (the
   * observation's own win on an id), both they and the players in view limited to the ones
   * the tree would fight (fair FFA: everyone, so only the merge applies).
   */
  private pilotView(o: BotObservation): BotObservation {
    const memories = o.memories.filter((m) => this.eligible(m));
    for (const m of this.memories.values())
      if (this.eligible(m) && !memories.some((x) => x.id === m.id)) memories.push(m);
    const visiblePlayers = o.visiblePlayers.filter((p) => this.eligible(p));
    return { ...o, memories, visiblePlayers };
  }

  private observe(observation: BotObservation): void {
    for (const p of observation.visiblePlayers) {
      this.memories.set(p.id, {
        id: p.id,
        pos: { ...p.pos },
        seenAt: observation.nowMs,
        isBot: p.isBot,
      });
    }
    for (const [id, m] of this.memories) {
      if (observation.nowMs - m.seenAt > BOT.memorySeconds * 1000) this.memories.delete(id);
    }
  }

  private pickTarget(observation: BotObservation): BotVisibleTarget | null {
    // The crew of the truck we ride in (or are boarding) is a truce.
    const truce = observation.self.seat?.vehicle ?? this.vehicles.truce();
    const players = observation.visiblePlayers.filter(
      (p) => this.eligible(p) && (truce === null || p.vehicle !== truce),
    );
    const drones =
      observation.mode === 'standard'
        ? (observation.visibleDrones ?? []).filter((d) => this.eligible(d))
        : [];
    const hittablePlayers = players.filter((p) => !p.protected);
    // Conservative drone policy: a live, hittable player is the immediate threat. A drone is a
    // ranged target only when no such player is visible; protected players still let it shoot down
    // the drone instead of staring at an invulnerable body.
    const choices: BotVisibleTarget[] = drones.length
      ? hittablePlayers.length
        ? hittablePlayers
        : drones
      : players;
    if (!choices.length) return null;
    const previous = choices.find((p) => p.id === this.currentTarget);
    // Stick with the current target, unless it is protected and someone hittable is in view.
    if (previous && (!previous.protected || choices.every((p) => p.protected))) return previous;
    let best = choices[0]!;
    let bestScore = Infinity;
    for (const p of choices) {
      const d = distance2d(observation.self.pos, p.pos);
      // A protected player can't be hurt yet: anyone else first (still tracked if alone).
      const score = d / Math.max(0.2, p.visibility) + (p.protected ? BOT.protectedPenalty : 0);
      if (score < bestScore) {
        best = p;
        bestScore = score;
      }
    }
    this.currentTarget = best.id;
    return best;
  }

  private mode(observation: BotObservation, target: BotVisibleTarget | null): BotMode {
    if (target?.kind === 'drone') return 'engage';
    const coverHealth = this.persona?.coverHealth ?? BOT.lowHealthCover;
    if (
      target &&
      (observation.self.health < PLAYER.maxHealth * coverHealth ||
        (observation.mode === 'standard' &&
          observation.self.weapon !== 'knife' &&
          observation.self.ammo <= BOT.lowAmmoReload &&
          observation.self.reserve > 0))
    )
      return 'cover';
    return target ? 'engage' : 'seek';
  }

  private goal(
    observation: BotObservation,
    target: BotVisibleTarget | null,
    mode: BotMode,
  ): Vec3 | null {
    if (target?.kind === 'drone') return null;
    if (mode === 'engage' && target) {
      const d = distance2d(observation.self.pos, target.pos);
      // A pack right here is worth grabbing mid-fight (when the target is farther than it).
      const grab = this.jet.packGoal(observation, Math.min(JETPACK_BOT.fightGrabRadius, d));
      if (grab) return grab;
      if (observation.mode === 'knife') return d > KNIFE.range * 0.75 ? target.pos : null;
      // A target seen reloading can't shoot back for a moment: rushers and flankers go for it.
      if (this.persona?.reloadPush && target.reloading && d > KNIFE.range) return target.pos;
      const range = this.ranges(observation);
      if (d > range.closeRange) return target.pos;
      if (d < KNIFE.range * 0.85) return null;
      return holdPoint(target.pos, observation.self.pos, range.engageRange);
    }
    if (mode === 'cover') {
      const threat = target
        ? { pos: target.pos, eye: target.eye }
        : this.memoryAsThreat(this.nearestMemory(observation));
      return threat ? this.coverPoint(observation, threat) : this.wanderPoint(observation, null);
    }
    // A free jetpack worth the detour comes first (personality decides).
    return this.jet.packGoal(observation) ?? this.seekGoal(observation);
  }

  /**
   * Nobody in sight: hunt the freshest memory (a flanker by way of a point off to the side),
   * else roam; anchors and marksmen stop at each spot they reach and hold it a while, watching
   * (`holdSeconds`; null = hold still here).
   */
  private seekGoal(observation: BotObservation): Vec3 | null {
    const memory = this.nearestMemory(observation);
    const now = observation.nowMs;
    if (memory) {
      this.holdUntil = 0;
      return this.approachPoint(observation, memory.pos);
    }
    this.flankGoal = null;
    const hold = this.persona?.holdSeconds ?? 0;
    if (hold > 0) {
      if (now < this.holdUntil) return null;
      const g = this.wanderGoal;
      const cell = observation.nav.cellSize;
      if (g && g !== this.heldGoal && distance2d(observation.self.pos, g) < cell * 1.5) {
        this.heldGoal = g;
        this.holdUntil = now + hold * (0.7 + this.rng() * 0.6) * 1000;
        this.holdYaw = this.yaw;
        return null;
      }
    }
    return this.wanderPoint(observation, null);
  }

  /** Where to look while holding a spot: a slow sweep across the way we came in. */
  private holdLook(observation: BotObservation): Vec3 | null {
    if (observation.nowMs >= this.holdUntil) return null;
    const self = observation.self;
    const look = this.holdYaw + Math.sin(observation.nowMs / 1400 + this.flankSide) * 1.1;
    return {
      x: self.eye.x - Math.sin(look) * 10,
      y: self.eye.y,
      z: self.eye.z - Math.cos(look) * 10,
    };
  }

  /**
   * The way in to a remembered target: straight for most; a flanker first heads for a point
   * `flankOffset` off the line between them (its side fixed per bot), then turns in.
   */
  private approachPoint(observation: BotObservation, at: Vec3): Vec3 {
    const offset = this.persona?.flankOffset ?? 0;
    const self = observation.self.pos;
    const d = distance2d(self, at);
    if (offset <= 0 || d < offset * 1.3) {
      this.flankGoal = null;
      return at;
    }
    if (!this.flankFor || distance2d(this.flankFor, at) > 4) {
      const dx = (at.x - self.x) / d;
      const dz = (at.z - self.z) / d;
      const side = { x: -dz * this.flankSide, z: dx * this.flankSide };
      const ahead = Math.max(0, d - offset);
      const node = observation.nav.nearest({
        x: self.x + dx * ahead + side.x * offset,
        y: at.y,
        z: self.z + dz * ahead + side.z * offset,
      });
      this.flankFor = { ...at };
      this.flankGoal = node ? { x: node.x, y: node.y, z: node.z } : null;
    }
    const g = this.flankGoal;
    if (!g || distance2d(self, g) < observation.nav.cellSize * 1.5) {
      this.flankGoal = null;
      return at;
    }
    return g;
  }

  /** The gun's fighting distances, scaled by the personality (`rangeScale`). */
  private ranges(observation: BotObservation): BotGunProfile {
    const base = gunRanges(observation);
    const k = this.persona?.rangeScale ?? 1;
    if (k === 1) return base;
    return {
      ...base,
      engageRange: base.engageRange * k,
      closeRange: Math.max(base.closeRange * k, base.engageRange * k + 2),
    };
  }

  /**
   * A tactical sprint burst when wanted: a fresh TacSprint edge (pressed every other tick) while
   * sprinting with enough in the tank, never during a burst. The sim decides if it starts.
   */
  private tacButton(observation: BotObservation, want: boolean): number {
    const self = observation.self;
    const press =
      want &&
      !this.tacPressed &&
      self.sprinting &&
      !self.tacSprint &&
      self.tacFuel >= TAC_SPRINT.minStart;
    this.tacPressed = press;
    return press ? Button.TacSprint : 0;
  }

  private buttons(
    observation: BotObservation,
    target: BotVisibleTarget | null,
    mode: BotMode,
    goal: Vec3 | null,
  ): number {
    let buttons = 0;
    const wantsReload =
      observation.mode === 'standard' &&
      observation.self.weapon !== 'knife' &&
      observation.self.ammo <= BOT.lowAmmoReload &&
      observation.self.reserve > 0;
    if (wantsReload) buttons |= Button.Reload;
    if (mode === 'cover') buttons |= Button.Crouch;
    const p = this.persona;
    if (!target) {
      // Holding a spot: still (an anchor crouched), no sprint.
      if (!goal) return buttons | (p && p.crouchFire > 0.5 ? Button.Crouch : 0);
      const far = distance2d(observation.self.pos, goal) > (p?.burstRange ?? Infinity);
      return buttons | Button.Sprint | this.tacButton(observation, (p?.tacSprint ?? false) && far);
    }
    const d = distance2d(observation.self.pos, target.pos);
    // Rushing a reloading target: sprint (and burst) in, the gun comes up when close.
    if (
      p?.reloadPush &&
      target.reloading &&
      d > KNIFE.range * 2 &&
      observation.mode === 'standard' &&
      !target.protected
    ) {
      return buttons | Button.Sprint | this.tacButton(observation, p.tacSprint && d > 6);
    }
    // Protected target: track it (weapon up, aimed) but hold fire, swings and throws; attacking
    // would waste rounds and our own protection. `acquired` false keeps every trigger off.
    const acquired = this.targetAcquired(observation, target) && !target.protected;
    if (target.kind === 'drone') {
      if (observation.mode === 'knife') return buttons;
      buttons |=
        Button.Ads |
        this.equip(observation, observation.self.primaryRounds > 0 ? 'rifle' : 'sidearm');
      return buttons | this.trigger(observation, d, acquired);
    }
    if (observation.mode === 'knife' || d < KNIFE.range * 0.9) {
      buttons |= this.equip(observation, 'knife') | (target.protected ? 0 : Button.Melee);
      if (acquired && d < KNIFE.range) buttons |= Button.Fire;
      return buttons;
    }
    // The primary until it is dry (every round spent), then the pistol.
    buttons |=
      Button.Ads |
      this.equip(observation, observation.self.primaryRounds > 0 ? 'rifle' : 'sidearm');
    buttons |= this.trigger(observation, d, acquired);
    // Some engagements are fought crouched (anchors, marksmen): steadier and smaller.
    if (this.crouchEngage && acquired && mode === 'engage') buttons |= Button.Crouch;
    if (
      observation.nowMs > this.nextGrenadeAt &&
      d > 8 &&
      d < 26 &&
      this.rng() < 0.18 * (p?.grenadeScale ?? 1) &&
      mode === 'engage' &&
      acquired
    ) {
      buttons |= Button.Grenade;
      this.nextGrenadeAt =
        observation.nowMs +
        (BOT.grenadeCooldownMin + this.rng() * BOT.grenadeCooldownJitter) * 1000;
    }
    return buttons;
  }

  /**
   * The slot button for `slot` while it isn't in hand. A switch is a press edge and busy hands
   * (a swing, a throw) drop it, so a held button would never retry: press on every other tick
   * (fresh edges) until the weapon is in hand. Repeats mid-switch are ignored by the sim.
   */
  private equip(observation: BotObservation, slot: 'rifle' | 'sidearm' | 'knife'): number {
    const button =
      slot === 'rifle' ? Button.Slot1 : slot === 'sidearm' ? Button.Slot2 : Button.Slot3;
    const press = observation.self.weapon !== slot && this.slotPressed !== button ? button : 0;
    this.slotPressed = press;
    return press;
  }

  /** Standing still to shoot: a `plant` gun in hand, the target acquired and in its range. */
  private planted(observation: BotObservation, target: BotVisibleTarget): boolean {
    const self = observation.self;
    if (target.kind === 'drone') return false;
    if (observation.mode === 'knife' || self.weapon === 'knife') return false;
    const d = distance2d(self.pos, target.pos);
    const range = this.ranges(observation);
    return (
      range.plant &&
      d >= KNIFE.range &&
      d <= range.fireRange &&
      this.targetAcquired(observation, target)
    );
  }

  /**
   * The trigger for the gun in hand, used the way it works: auto and semi guns are pressed once
   * per round at their own cadence; the coilgun is held through its charge and released after
   * each shot (a spent press never fires again); scoped guns wait for the scope; energy guns
   * ease off before they overheat; nothing fires past the gun's useful range.
   */
  private trigger(observation: BotObservation, d: number, acquired: boolean): number {
    const self = observation.self;
    if (self.weapon === 'knife') return 0;
    const gun = gunConfig({ primary: self.primary }, self.weapon);
    if (!gun.heat) this.venting = false;
    else if (self.heat >= BOT.heatRelease) this.venting = true;
    else if (self.heat <= BOT.heatResume) this.venting = false;
    const ready =
      acquired &&
      d <= this.ranges(observation).fireRange &&
      !(gun.scope && self.adsAmount < BOT.scopedFireAds) &&
      !this.venting;
    const now = observation.nowMs;
    const interval = 60_000 / gun.roundsPerMinute;
    const fireChance = BOT.difficulty[this.config.difficulty].fireChance;
    if (gun.chargeTime > 0) {
      if (!ready || self.charge < 0) {
        // Shot away (or no longer worth it): release, so the next press charges afresh.
        if (this.charging && self.charge < 0) this.nextFireAt = now + interval;
        this.charging = false;
        return 0;
      }
      // A charge starts only with the crosshair on the body, then is held through it.
      if (!this.charging && now >= this.nextFireAt && this.onTarget) {
        if (this.rng() < fireChance) this.charging = true;
        else this.nextFireAt = now + interval;
      }
      return this.charging ? Button.Fire : 0;
    }
    this.charging = false;
    // Like a player: shoot when the crosshair (recoil kick included) is on the body.
    if (!ready || !this.onTarget || now < this.nextFireAt) return 0;
    this.nextFireAt = now + interval;
    if (this.rng() >= fireChance) return 0;
    if (!gun.semiAuto && ++this.burst >= BOT.burstRounds) {
      // Full auto: a short burst, then let the recoil settle (a spray walks off the target).
      this.burst = 0;
      this.nextFireAt = now + BOT.burstPause * 1000;
    }
    return Button.Fire;
  }

  private steer(pos: Vec3, goal: Vec3, graph: NavGraph, nowMs: number): { x: number; z: number } {
    if (!this.pathGoal || distance2d(this.pathGoal, goal) > graph.cellSize) {
      const route = graph.route(pos, goal);
      this.path = route.points;
      this.pathComplete = route.complete;
      this.pathGoal = { ...goal };
    }
    // Past the end of a complete route the goal is in the open; past a partial (capped) one it
    // isn't, so search again from here instead of walking straight at it.
    const end = this.pathComplete ? goal : pos;
    let waypoint = this.path[0] ?? end;
    while (this.path.length && distance2d(pos, waypoint) < graph.cellSize * 0.45) {
      this.path = this.path.slice(1);
      waypoint = this.path[0] ?? end;
    }
    if (!this.path.length && !this.pathComplete) this.pathGoal = null;
    const unstick = this.unstick(pos, graph, nowMs);
    this.lastPos = { ...pos };
    const dx = waypoint.x - pos.x;
    const dz = waypoint.z - pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return { x: 0, z: 0 };
    const yaw = this.yaw;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    return normalizeInput({
      x: rightX * (dx / len) + rightZ * (dz / len) + unstick.x,
      z: forwardX * (dx / len) + forwardZ * (dz / len) + unstick.z,
    });
  }

  /** No target: look toward where we are going (re-read every reaction interval). */
  private aim(observation: BotObservation, at: Vec3, dt: number): { yaw: number; pitch: number } {
    const cfg = BOT.difficulty[this.config.difficulty];
    if (observation.nowMs >= this.nextReactAt) {
      this.nextReactAt = observation.nowMs + cfg.reactionMs * (0.65 + this.rng() * 0.7);
      const desired = aimAt(observation.self.eye, at);
      this.desiredYaw = desired.yaw;
      this.desiredPitch = desired.pitch;
    }
    this.onTarget = false;
    return this.turn(observation, false, dt);
  }

  /**
   * Aim at a target the way a player does. Nothing moves until the target is acquired (the
   * reaction), then the view turns (capped at `turnRate`) toward where the target was
   * `trackLagMs` ago, with an acquisition error that settles over `settleMs` and a steady
   * `aimError` wobble, at centre mass or (per engagement, `headAimChance`) the head. Recoil is
   * pulled against as far as `recoilControl`. `onTarget` = the crosshair is on the body.
   */
  private aimAtTarget(
    observation: BotObservation,
    target: BotVisibleTarget,
    dt: number,
  ): { yaw: number; pitch: number } {
    const cfg = BOT.difficulty[this.config.difficulty];
    const now = observation.nowMs;
    const self = observation.self;
    if (!this.targetAcquired(observation, target)) {
      this.onTarget = false;
      return this.turn(observation, true, dt);
    }
    if (this.settledFor !== target.id) {
      this.settledFor = target.id;
      this.tracked = [];
      this.aimHead = target.kind !== 'drone' && this.rng() < cfg.headAimChance;
      // (Drawn only with a personality: the plain tree's random stream stays as it was.)
      this.crouchEngage = this.persona ? this.rng() < this.persona.crouchFire : false;
      const dir = this.rng() * Math.PI * 2;
      const size = cfg.settleError * (0.5 + this.rng());
      this.settleYaw = Math.cos(dir) * size;
      this.settlePitch = Math.sin(dir) * size * 0.6;
    }
    const k = target.kind === 'drone' ? 1 : (target.eye.y - target.pos.y) / PLAYER.standEyeHeight;
    this.tracked.push({
      ms: now,
      p: {
        x: target.eye.x,
        y:
          target.kind === 'drone'
            ? target.pos.y
            : this.aimHead
              ? target.eye.y + BOT_HEAD_ABOVE_EYE * k
              : target.pos.y + BOT_CHEST * k,
        z: target.eye.z,
      },
    });
    const lagged = now - cfg.trackLagMs;
    while (this.tracked.length > 1 && this.tracked[1]!.ms <= lagged) this.tracked.shift();
    const want = aimAt(self.eye, this.tracked[0]!.p);
    if (now >= this.nextReactAt) {
      this.nextReactAt = now + cfg.reactionMs * (0.65 + this.rng() * 0.7);
      this.jitterYaw = (this.rng() - 0.5) * cfg.aimError;
      this.jitterPitch = (this.rng() - 0.5) * cfg.aimError * 0.5;
    }
    const decay = Math.exp((-dt * 1000) / cfg.settleMs);
    this.settleYaw *= decay;
    this.settlePitch *= decay;
    const kickPitch = self.recoilPitch * DEG;
    const kickYaw = self.recoilYaw * DEG;
    this.desiredYaw = want.yaw + this.settleYaw + this.jitterYaw + kickYaw * cfg.recoilControl;
    this.desiredPitch =
      want.pitch + this.settlePitch + this.jitterPitch - kickPitch * cfg.recoilControl;
    const aim = this.turn(observation, true, dt);
    // The crosshair is the view plus the kick; on target within the torso's width (scaled).
    const d = Math.max(1, distance2d(self.pos, target.pos));
    const halfWidth = target.kind === 'drone' ? DRONE.radius : BOT_TORSO_HALF_WIDTH;
    const tolerance = Math.max(
      Math.atan2(halfWidth * BOT.fireTolerance, d),
      BOT.fireToleranceMinDeg * DEG,
    );
    const err = Math.hypot(
      wrapAngle(aim.yaw - kickYaw - want.yaw),
      aim.pitch + kickPitch - want.pitch,
    );
    this.onTarget = err <= tolerance;
    return aim;
  }

  /** Turn the view toward the desired aim at the difficulty's turn rate; pick a strafe. */
  private turn(
    observation: BotObservation,
    hostile: boolean,
    dt: number,
  ): { yaw: number; pitch: number } {
    const cfg = BOT.difficulty[this.config.difficulty];
    this.yaw = approachAngle(this.yaw, this.desiredYaw, cfg.turnRate * dt);
    this.pitch = approach(this.pitch, this.desiredPitch, cfg.turnRate * dt);
    if (observation.nowMs > this.strafeUntil) {
      this.strafeUntil = observation.nowMs + 500 + this.rng() * 900;
      const strafeChance = Math.min(0.95, cfg.strafeChance * (this.persona?.strafeScale ?? 1));
      this.strafe =
        hostile && !this.crouchEngage && this.rng() < strafeChance
          ? this.rng() < 0.5
            ? -0.7
            : 0.7
          : 0;
    }
    return { yaw: this.yaw, pitch: this.pitch };
  }

  private nearestMemory(observation: BotObservation): BotMemory | null {
    const visible = new Set(observation.visiblePlayers.map((p) => p.id));
    let best: BotMemory | null = null;
    let bestD = Infinity;
    for (const m of this.memories.values()) {
      if (visible.has(m.id)) continue;
      if (!this.eligible(m)) continue;
      const d = distance2d(observation.self.pos, m.pos) + (observation.nowMs - m.seenAt) / 1000;
      if (d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  private wanderPoint(observation: BotObservation, graph: NavGraph | null): Vec3 {
    const g = graph ?? observation.nav;
    // Only the largest connected area: an island target would send A* round the whole graph.
    const targets = g.wanderNodes;
    if (!targets.length) return observation.self.pos;
    if (
      !this.wanderGoal ||
      observation.nowMs >= this.wanderUntil ||
      distance2d(observation.self.pos, this.wanderGoal) < g.cellSize
    ) {
      const idx =
        hashSeed(
          this.config.seed,
          Math.floor(observation.nowMs / (BOT.wanderMinSeconds * 1000)),
          Math.floor(this.rng() * 1e6),
        ) % targets.length;
      const n = targets[idx]!;
      this.wanderGoal = { x: n.x, y: n.y, z: n.z };
      this.wanderUntil =
        observation.nowMs + (BOT.wanderMinSeconds + this.rng() * BOT.wanderJitterSeconds) * 1000;
    }
    return this.wanderGoal;
  }

  private memoryAsThreat(memory: BotMemory | null): { pos: Vec3; eye: Vec3 } | null {
    if (!memory) return null;
    return {
      pos: memory.pos,
      eye: { x: memory.pos.x, y: memory.pos.y + PLAYER.standEyeHeight, z: memory.pos.z },
    };
  }

  private coverPoint(observation: BotObservation, threat: { pos: Vec3; eye: Vec3 }): Vec3 {
    const graph = observation.nav;
    if (
      this.coverGoal &&
      this.coverThreat &&
      observation.nowMs < this.coverUntil &&
      distance2d(this.coverThreat, threat.pos) < graph.cellSize
    )
      return this.coverGoal;
    let best: Vec3 | null = null;
    let bestScore = -Infinity;
    const currentThreatDistance = distance2d(observation.self.pos, threat.pos);
    for (const n of graph.nodes) {
      const p = { x: n.x, y: n.y, z: n.z };
      const selfDistance = distance2d(observation.self.pos, p);
      if (selfDistance > BOT.coverSearchRadius || selfDistance < 2) continue;
      const threatDistance = distance2d(threat.pos, p);
      if (threatDistance < currentThreatDistance - 1) continue;
      const eye = { x: p.x, y: p.y + PLAYER.standEyeHeight, z: p.z };
      if (graph.lineOfSight(threat.eye, eye)) continue;
      const score = threatDistance - selfDistance * 0.35;
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    this.coverGoal = best ?? offsetFrom(observation.self.pos, threat.pos, 7);
    this.coverThreat = { ...threat.pos };
    this.coverUntil = observation.nowMs + 250;
    return this.coverGoal;
  }

  private initializeAim(observation: BotObservation): void {
    if (this.initialized) return;
    this.initialized = true;
    this.yaw = observation.self.yaw;
    this.pitch = observation.self.pitch;
    this.desiredYaw = this.yaw;
    this.desiredPitch = this.pitch;
  }

  private updateAcquisition(observation: BotObservation, target: BotVisibleTarget | null): void {
    if (!target) {
      this.acquiredTargetId = null;
      this.acquiredReadyAt = Infinity;
      this.currentTarget = null;
      this.settledFor = null;
      return;
    }
    if (target.id === this.acquiredTargetId) return;
    const wasDrone = this.acquiredTargetId?.startsWith('drone:') === true;
    this.acquiredTargetId = target.id;
    if (wasDrone && target.kind !== 'drone') {
      const desired = aimAt(observation.self.eye, target.eye);
      this.desiredYaw = desired.yaw;
      this.desiredPitch = desired.pitch;
    }
    const cfg = BOT.difficulty[this.config.difficulty];
    this.acquiredReadyAt = observation.nowMs + cfg.reactionMs * (0.75 + this.rng() * 0.5);
    this.nextReactAt = observation.nowMs;
  }

  private targetAcquired(observation: BotObservation, target: BotVisibleTarget): boolean {
    return target.id === this.acquiredTargetId && observation.nowMs >= this.acquiredReadyAt;
  }

  private unstick(pos: Vec3, graph: NavGraph, nowMs: number): { x: number; z: number } {
    if (nowMs < this.unstickUntil) return { x: this.unstickMove.x, z: this.unstickMove.z };
    if (!this.progressPos) {
      this.progressPos = { ...pos };
      this.progressAt = nowMs;
      return { x: 0, z: 0 };
    }
    const elapsed = nowMs - this.progressAt;
    if (elapsed < BOT.stuckWindowSeconds * 1000) return { x: 0, z: 0 };
    const progressed = distance2d(pos, this.progressPos);
    this.progressPos = { ...pos };
    this.progressAt = nowMs;
    if (progressed >= BOT.stuckMinProgress) return { x: 0, z: 0 };
    this.path = [];
    this.pathGoal = null;
    this.unstickUntil = nowMs + BOT.unstickSeconds * 1000;
    this.unstickMove = {
      x: this.rng() < 0.5 ? -0.85 : 0.85,
      z: this.rng() < 0.5 ? -0.6 : 0.2,
      jump: this.rng() < 0.45 && graph.nodes.length > 0,
    };
    return { x: this.unstickMove.x, z: this.unstickMove.z };
  }
}

export function createBehaviorTreeBot(config: BotConfig): BehaviorTreeDecisionProvider {
  return new BehaviorTreeDecisionProvider(config);
}

/** Fighting distances for the gun in hand (`BOT.weapons`; the pistol once the primary is dry). */
function gunRanges(observation: BotObservation): BotGunProfile {
  const self = observation.self;
  return self.weapon === 'sidearm' ? BOT.sidearm : BOT.weapons[self.primary];
}

const DEG = Math.PI / 180;
/** Aim points on the target (m, standing; scaled with the eye height): centre mass, head. */
const BOT_CHEST = 1.2;
const BOT_HEAD_ABOVE_EYE = 0.03;
/** Torso capsule radius (`humanoidHitboxes`): "on the body" for the fire decision. */
const BOT_TORSO_HALF_WIDTH = 0.24;

function wrapAngle(a: number): number {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
}

function distance2d(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Where to stand to fight `target` from `range` away: on our side of it. (The engage goal used to
 * be `offsetFrom(target, self, range)`, a point *beyond* the target, so bots ran through their
 * target into knife range.)
 */
export function holdPoint(target: Vec3, self: Vec3, range: number): Vec3 {
  return offsetFrom(target, self, -range);
}

function offsetFrom(origin: Vec3, away: Vec3, distance: number): Vec3 {
  const dx = origin.x - away.x;
  const dz = origin.z - away.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: origin.x + (dx / len) * distance, y: origin.y, z: origin.z + (dz / len) * distance };
}

function normalizeInput(v: { x: number; z: number }): { x: number; z: number } {
  const len = Math.hypot(v.x, v.z);
  if (len <= 1) return v;
  return { x: v.x / len, z: v.z / len };
}

function aimAt(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

function approach(current: number, target: number, maxDelta: number): number {
  const delta = Math.max(-maxDelta, Math.min(maxDelta, target - current));
  return current + delta;
}

function approachAngle(current: number, target: number, maxDelta: number): number {
  let delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return current + Math.max(-maxDelta, Math.min(maxDelta, delta));
}
