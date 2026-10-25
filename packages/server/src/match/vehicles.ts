import {
  chooseSeat,
  createVehicleMotion,
  findExitSpot,
  hullAt,
  hullClosestPoint,
  hullObstacle,
  lerpAngle,
  MATCH_NET,
  nextFreeSeat,
  PLAYER,
  pushOutOfVehicle,
  SEATS,
  seatEyeHeight,
  seatFeet,
  SIM,
  SIM_DT,
  stepVehicle,
  VEHICLE,
  VEHICLE_STATES,
  jetActive,
  motionToWire,
  type MapDefinition,
  type PhysicsWorld,
  type SeatId,
  type SnapshotVehicle,
  type Vec3,
  type VehicleCondition,
  type VehicleHull,
  type VehicleMotion,
  type VehicleObstacle,
  type VehicleProps,
} from '@wd/shared';

/** One recorded vehicle pose (lag compensation rewinds the hull and its seats into these). */
export interface VehiclePose {
  ms: number;
  pos: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  condition: VehicleCondition;
}

/** A vehicle's recent poses, one per tick (like `PoseHistory` for players). */
export class VehicleHistory {
  private readonly poses: VehiclePose[] = [];
  constructor(private readonly capacity: number = MATCH_NET.historyTicks) {}

  record(p: VehiclePose): void {
    const last = this.poses.at(-1);
    if (last && p.ms <= last.ms) this.poses.pop();
    this.poses.push({ ...p, pos: { ...p.pos } });
    if (this.poses.length > this.capacity) this.poses.shift();
  }

  clear(): void {
    this.poses.length = 0;
  }

  /** The pose at `ms`, blended between ticks (never across a respawn or a condition change). */
  at(ms: number): VehiclePose | null {
    const h = this.poses;
    const first = h[0];
    if (!first) return null;
    if (ms <= first.ms) return first;
    for (let i = 1; i < h.length; i++) {
      const b = h[i]!;
      if (ms > b.ms) continue;
      const a = h[i - 1]!;
      if (a.condition !== b.condition) return ms - a.ms < b.ms - ms ? a : b;
      const k = (ms - a.ms) / (b.ms - a.ms);
      const l = (x: number, y: number): number => x + (y - x) * k;
      return {
        ms,
        pos: { x: l(a.pos.x, b.pos.x), y: l(a.pos.y, b.pos.y), z: l(a.pos.z, b.pos.z) },
        yaw: lerpAngle(a.yaw, b.yaw, k),
        pitch: l(a.pitch, b.pitch),
        roll: l(a.roll, b.roll),
        condition: a.condition,
      };
    }
    return h.at(-1)!;
  }
}

export interface ServerVehicle {
  readonly id: number;
  readonly spawn: { pos: Vec3; yaw: number };
  motion: VehicleMotion;
  health: number;
  condition: VehicleCondition;
  /** Tick the wreck clears (`wreck`) or the truck is back at its spawn (`gone`). */
  until: number;
  /** Tick a destroyed truck is due back (`VEHICLE.respawnDelay` after the blast). */
  respawnTick: number;
  /** Who sits where (player ids). */
  readonly seats: Record<SeatId, string | null>;
  readonly history: VehicleHistory;
  /** The last driver (a run-over by the rolling truck after a bail-out still credits them). */
  lastDriver: string | null;
  lastDriverTick: number;
  /** Who damaged it last (the kill credit for its explosion). */
  lastAttacker: string | null;
  /** Run-over victims → tick they were last hit (cooldown). */
  readonly runOver: Map<string, number>;
  /** The tick its driver last stepped it (driverless trucks roll on by the server's tick). */
  drivenTick: number;
}

/** What the vehicle rules need from a player (MatchSim's `ServerPlayer`). */
export interface VehicleRider {
  readonly id: string;
  readonly ready: boolean;
  state: {
    health: number;
    seat: { vehicle: number; seat: SeatId; motion?: VehicleMotion } | null;
    move: {
      pos: Vec3;
      vel: Vec3;
      eyeHeight: number;
      grounded: boolean;
      crouched: boolean;
      prone: boolean;
      board: boolean;
      traversal: unknown;
      sliding: boolean;
      /** Jetpack mode (`JetMode`): in the air on it, no boarding. */
      jet: number;
    };
    spawnGuard: number;
  };
  readonly body: {
    setPosition(feet: Vec3): void;
    setCrouched(c: boolean): boolean;
    setProne?(p: boolean): boolean;
    setGrounded?(g: boolean): void;
  };
}

/** A damage request the match applies (it owns health, kills and the combat events). */
export interface VehicleDamage {
  target: string;
  by: string;
  amount: number;
  weapon: 'truck' | 'wreck';
  at: Vec3;
  from: Vec3;
}

/**
 * The match's vehicles (server-authoritative): seats, the driverless roll, occupants riding,
 * run-overs, damage, destruction and respawn. Driven trucks are stepped by their driver's own
 * inputs inside `stepPlayer` (the motion object is shared with the driver's seat state), exactly
 * as the driver's client predicts them.
 */
export class MatchVehicles {
  readonly list: ServerVehicle[] = [];
  /** Destructions since the last `takeBooms` (the match turns them into blasts and events). */
  private booms: { v: ServerVehicle; by: string }[] = [];

  /** Props a rolling, driverless truck breaks through (the match's). */
  props?: VehicleProps;

  constructor(
    map: MapDefinition,
    private readonly physics: PhysicsWorld,
    enabled: boolean,
    spawns: MapDefinition['vehicles'] = map.vehicles,
  ) {
    if (!enabled) return;
    const b = map.bounds;
    (spawns ?? []).forEach((s, i) => {
      if (s.x < b.minX || s.x > b.maxX || s.z < b.minZ || s.z > b.maxZ) return;
      const down = physics.castRay({ x: s.x, y: (s.y ?? 0) + 3, z: s.z }, { x: 0, y: -1, z: 0 }, 8);
      const pos = { x: s.x, y: down ? down.point.y : (s.y ?? 0), z: s.z };
      this.list.push({
        id: i + 1,
        spawn: { pos, yaw: s.yaw },
        motion: createVehicleMotion(pos, s.yaw),
        health: VEHICLE.maxHealth,
        condition: 'active',
        until: 0,
        respawnTick: 0,
        seats: { driver: null, front: null, rearL: null, rearR: null },
        history: new VehicleHistory(),
        lastDriver: null,
        lastDriverTick: -Infinity,
        lastAttacker: null,
        runOver: new Map(),
        drivenTick: -1,
      });
    });
  }

  get(id: number): ServerVehicle | undefined {
    return this.list.find((v) => v.id === id);
  }

  occupied(v: ServerVehicle): Set<SeatId> {
    return new Set(SEATS.filter((s) => v.seats[s] !== null));
  }

  /** Every vehicle still standing (active or wreck) as a ground obstacle. */
  obstacles(out: VehicleObstacle[] = []): VehicleObstacle[] {
    out.length = 0;
    for (const v of this.list)
      if (v.condition !== 'gone') out.push(hullObstacle(v.id, v.motion.pos, v.motion.yaw));
    return out;
  }

  /** Hulls as they were at server time `ms` (bullets and sight check against these). */
  hullsAt(ms: number): VehicleHull[] {
    const out: VehicleHull[] = [];
    for (const v of this.list) {
      const p = v.history.at(ms) ?? this.poseNow(v, ms);
      if (p.condition === 'gone') continue;
      out.push(hullAt(v.id, p.pos, p.yaw, p.pitch, p.roll, p.condition === 'wreck'));
    }
    return out;
  }

  /** Hulls now. */
  hullsNow(): VehicleHull[] {
    return this.list
      .filter((v) => v.condition !== 'gone')
      .map((v) => {
        const m = v.motion;
        return hullAt(v.id, m.pos, m.yaw, m.pitch, m.roll, v.condition === 'wreck');
      });
  }

  private poseNow(v: ServerVehicle, ms: number): VehiclePose {
    const m = v.motion;
    return { ms, pos: m.pos, yaw: m.yaw, pitch: m.pitch, roll: m.roll, condition: v.condition };
  }

  /** The eye of a seated player at server time `ms` (their shots leave from what they saw). */
  seatEyeAt(vehicle: number, seat: SeatId, ms: number): Vec3 | null {
    const v = this.get(vehicle);
    if (!v) return null;
    const p = v.history.at(ms) ?? this.poseNow(v, ms);
    const m = { ...v.motion, pos: p.pos, yaw: p.yaw, pitch: p.pitch, roll: p.roll };
    const feet = seatFeet(m, seat);
    return { x: feet.x, y: feet.y + seatEyeHeight(seat), z: feet.z };
  }

  /** The heading of a vehicle at `ms` (fire arcs). */
  yawAt(vehicle: number, ms: number): number {
    const v = this.get(vehicle);
    if (!v) return 0;
    return (v.history.at(ms) ?? this.poseNow(v, ms)).yaw;
  }

  /** A driver steps their own vehicle: make sure their seat holds the vehicle's motion. */
  bindDriver(p: VehicleRider): void {
    const s = p.state.seat;
    if (!s || s.seat !== 'driver') return;
    const v = this.get(s.vehicle);
    if (v) s.motion = v.motion;
  }

  /** After a driver's step: the vehicle's motion is the one the step advanced. */
  afterDriverStep(p: VehicleRider, tick: number): void {
    const s = p.state.seat;
    if (!s || s.seat !== 'driver' || !s.motion) return;
    const v = this.get(s.vehicle);
    if (!v) return;
    v.motion = s.motion;
    v.drivenTick = tick;
    v.lastDriver = p.id;
    v.lastDriverTick = tick;
  }

  /** A reachable free seat keeps Interact priority, including during its brief cooldown. */
  hasSeatInRange(p: VehicleRider): boolean {
    const m = p.state.move;
    if (
      !p.ready ||
      p.state.health <= 0 ||
      p.state.seat ||
      m.prone ||
      m.board ||
      m.traversal ||
      jetActive(m)
    )
      return false;
    return this.list.some(
      (v) =>
        v.condition === 'active' &&
        chooseSeat(v.motion, this.occupied(v), m.pos, this.physics) !== null,
    );
  }

  /**
   * Interact / SwitchSeat presses of one step (`pressed` edges): get in (the nearest free seat
   * within reach), switch to the next free seat, or get out to a safe spot. Seat changes are
   * spaced by `VEHICLE.seatCooldown`. Returns true if the player's seat changed.
   */
  seatInput(
    p: VehicleRider,
    interact: boolean,
    switchSeat: boolean,
    tick: number,
    cooldowns: Map<string, number>,
  ): boolean {
    if (!interact && !switchSeat) return false;
    if (p.state.health <= 0 || !p.ready) return false;
    if (tick < (cooldowns.get(p.id) ?? -Infinity)) return false;
    const cur = p.state.seat;
    let changed = false;
    if (cur) {
      const v = this.get(cur.vehicle);
      if (!v) return false;
      if (interact) changed = this.exit(p, v);
      else {
        const next = nextFreeSeat(cur.seat, this.occupied(v));
        if (next) {
          this.sit(p, v, next, cur.seat);
          changed = true;
        }
      }
    } else if (interact) {
      const m = p.state.move;
      // Not from the air: a flying (or dropping) jetpack wearer can't board (Interact is ignored).
      if (m.prone || m.board || m.traversal || jetActive(m)) return false;
      let best: { v: ServerVehicle; seat: SeatId; d: number } | null = null;
      for (const v of this.list) {
        if (v.condition !== 'active') continue;
        const seat = chooseSeat(v.motion, this.occupied(v), m.pos, this.physics);
        if (!seat) continue;
        const d = Math.hypot(v.motion.pos.x - m.pos.x, v.motion.pos.z - m.pos.z);
        if (!best || d < best.d) best = { v, seat, d };
      }
      if (best) {
        this.sit(p, best.v, best.seat, null);
        // Getting in is acting: spawn protection never shields a driver or a gunner.
        p.state.spawnGuard = 0;
        changed = true;
      }
    }
    if (changed) cooldowns.set(p.id, tick + Math.round(VEHICLE.seatCooldown * SIM.tickHz));
    return changed;
  }

  private sit(p: VehicleRider, v: ServerVehicle, seat: SeatId, from: SeatId | null): void {
    if (from) v.seats[from] = null;
    v.seats[seat] = p.id;
    p.state.seat = { vehicle: v.id, seat, ...(seat === 'driver' ? { motion: v.motion } : {}) };
    const m = p.state.move;
    m.crouched = false;
    m.prone = false;
    m.sliding = false;
    m.traversal = null;
    this.place(p, v, seat);
  }

  /** Out to the safe spot beside the truck (stays in if boxed in). */
  private exit(p: VehicleRider, v: ServerVehicle): boolean {
    const cur = p.state.seat!;
    const others = this.obstacles().filter((o) => o.id !== v.id);
    const spot = findExitSpot(this.physics, v.motion, cur.seat, (feet) =>
      others.some((o) => pushOutOfVehicle(feet, PLAYER.radius, PLAYER.standHeight, o) !== null),
    );
    if (!spot) return false;
    this.unseat(p, v);
    const m = p.state.move;
    m.pos = spot;
    // Bailing out of a moving truck carries some of its speed.
    m.vel = { x: v.motion.vel.x * 0.5, y: 0, z: v.motion.vel.z * 0.5 };
    m.eyeHeight = PLAYER.standEyeHeight;
    m.grounded = false;
    p.body.setPosition(spot);
    p.body.setCrouched(false);
    p.body.setProne?.(false);
    p.body.setGrounded?.(false);
    return true;
  }

  /** Free a player's seat (exit, death, leaving, respawn). */
  unseat(p: VehicleRider, v?: ServerVehicle): void {
    const s = p.state.seat;
    if (!s) return;
    const veh = v ?? this.get(s.vehicle);
    if (veh && veh.seats[s.seat] === p.id) veh.seats[s.seat] = null;
    p.state.seat = null;
  }

  /** Forget a player everywhere (they left, or respawned with a fresh state). */
  release(id: string): void {
    for (const v of this.list) {
      for (const s of SEATS) if (v.seats[s] === id) v.seats[s] = null;
      v.runOver.delete(id);
    }
  }

  /** Put an occupant where its seat is now. */
  place(p: VehicleRider, v: ServerVehicle, seat: SeatId): void {
    const m = p.state.move;
    m.pos = seatFeet(v.motion, seat);
    m.vel = { ...v.motion.vel };
    m.eyeHeight = seatEyeHeight(seat);
    m.grounded = true;
  }

  /**
   * The rest of the tick, after every player's inputs: trucks without a driver roll to a stop
   * (handbrake), occupants ride, run-overs hurt, wrecks clear and trucks come back. Returns the
   * damage the match applies (run-overs).
   */
  step(riders: ReadonlyMap<string, VehicleRider>, tick: number, playing: boolean): VehicleDamage[] {
    const out: VehicleDamage[] = [];
    const obstacles = this.obstacles();
    for (const v of this.list) {
      if (v.condition === 'gone') {
        if (tick >= v.until) this.tryRespawn(v, riders);
        continue;
      }
      if (v.condition === 'wreck' && tick >= v.until) {
        v.condition = 'gone';
        v.until = v.respawnTick;
        for (const s of SEATS) v.seats[s] = null;
        continue;
      }
      const driver = v.seats.driver;
      const m = v.motion;
      // Driverless rolls on — unless a driver's step already moved it this tick (they got out
      // or switched seats mid-input): never advanced twice.
      if ((!driver || v.condition === 'wreck') && v.drivenTick !== tick) {
        const moving = Math.hypot(m.vel.x, m.vel.y, m.vel.z) > 0.01 || !m.grounded;
        if (moving)
          stepVehicle(
            m,
            { throttle: 0, steer: 0, handbrake: true },
            SIM_DT,
            this.physics,
            obstacles,
            v.id,
            this.props,
          );
      }
      for (const seat of SEATS) {
        const id = v.seats[seat];
        const r = id ? riders.get(id) : undefined;
        if (!id) continue;
        if (!r || r.state.health <= 0 || r.state.seat?.vehicle !== v.id) {
          v.seats[seat] = null;
          continue;
        }
        this.place(r, v, seat);
      }
      if (playing && v.condition === 'active') this.runOvers(v, riders, tick, out);
    }
    return out;
  }

  /**
   * Run-overs by one truck right after it moved (a driver's step), before its victims' own steps
   * shove them out of the hull.
   */
  runOversOf(id: number, riders: ReadonlyMap<string, VehicleRider>, tick: number): VehicleDamage[] {
    const v = this.get(id);
    const out: VehicleDamage[] = [];
    if (v && v.condition === 'active') this.runOvers(v, riders, tick, out);
    return out;
  }

  private runOvers(
    v: ServerVehicle,
    riders: ReadonlyMap<string, VehicleRider>,
    tick: number,
    out: VehicleDamage[],
  ): void {
    const m = v.motion;
    const speed = Math.hypot(m.vel.x, m.vel.z);
    if (speed < VEHICLE.runOverSpeed) return;
    const o = hullObstacle(v.id, m.pos, m.yaw);
    const credit =
      v.seats.driver ??
      (v.lastDriver && tick - v.lastDriverTick < 3 * SIM.tickHz ? v.lastDriver : null);
    for (const r of riders.values()) {
      if (r.state.seat || r.state.health <= 0 || !r.ready) continue;
      const q = r.state.move;
      const height = q.crouched
        ? PLAYER.crouchHeight
        : q.prone
          ? PLAYER.proneHeight
          : PLAYER.standHeight;
      const push = pushOutOfVehicle(q.pos, PLAYER.radius + 0.1, height, o);
      if (!push) continue;
      const len = Math.hypot(push.x, push.z);
      if (len < 1e-6) continue;
      const nx = push.x / len;
      const nz = push.z / len;
      // Closing speed: the truck's velocity toward the player minus theirs away from it.
      const closing = (m.vel.x - q.vel.x) * nx + (m.vel.z - q.vel.z) * nz;
      if (closing <= VEHICLE.runOverSpeed) continue;
      const last = v.runOver.get(r.id);
      if (last !== undefined && tick - last < VEHICLE.runOverCooldown * SIM.tickHz) continue;
      v.runOver.set(r.id, tick);
      out.push({
        target: r.id,
        by: credit ?? r.id,
        amount: Math.round(VEHICLE.runOverDamage * (closing - VEHICLE.runOverSpeed)),
        weapon: 'truck',
        at: { x: q.pos.x, y: q.pos.y + 1, z: q.pos.z },
        from: { x: m.pos.x, y: m.pos.y + 1, z: m.pos.z },
      });
    }
  }

  private tryRespawn(v: ServerVehicle, riders: ReadonlyMap<string, VehicleRider>): void {
    const o = hullObstacle(v.id, v.spawn.pos, v.spawn.yaw);
    // Never on top of someone: wait until the spot is clear (players and other trucks).
    for (const r of riders.values()) {
      if (r.state.health > 0 && pushOutOfVehicle(r.state.move.pos, 0.6, PLAYER.standHeight, o))
        return;
    }
    for (const w of this.list) {
      if (w === v || w.condition === 'gone') continue;
      if (Math.hypot(w.motion.pos.x - v.spawn.pos.x, w.motion.pos.z - v.spawn.pos.z) < 6) return;
    }
    this.resetVehicle(v, true);
  }

  private resetVehicle(v: ServerVehicle, keepHistory = false): void {
    v.motion = createVehicleMotion(v.spawn.pos, v.spawn.yaw);
    v.health = VEHICLE.maxHealth;
    v.condition = 'active';
    v.until = 0;
    v.respawnTick = 0;
    for (const s of SEATS) v.seats[s] = null;
    v.lastAttacker = null;
    v.lastDriver = null;
    v.runOver.clear();
    // A respawn keeps the history: a shot rewound to before it must still find the truck gone
    // (or the wreck) there, not the new truck. A fresh match starts it over.
    if (!keepHistory) v.history.clear();
  }

  /** A fresh match: every truck back at its spawn, intact and empty. */
  reset(): void {
    for (const v of this.list) this.resetVehicle(v);
    this.booms = [];
  }

  /**
   * Damage to a vehicle from `by` (already scaled for armour). At 0 it is destroyed: it becomes a
   * wreck and the match blows it up (`takeBooms`). Returns the damage applied.
   */
  damage(v: ServerVehicle, by: string, amount: number, tick: number): number {
    if (v.condition !== 'active' || amount <= 0) return 0;
    const dealt = Math.min(v.health, amount);
    v.health -= dealt;
    v.lastAttacker = by;
    if (v.health <= 0) {
      v.health = 0;
      v.condition = 'wreck';
      v.until = tick + Math.round(VEHICLE.wreckTime * SIM.tickHz);
      v.respawnTick = tick + Math.round(VEHICLE.respawnDelay * SIM.tickHz);
      v.motion.vel = { x: v.motion.vel.x * 0.3, y: 0, z: v.motion.vel.z * 0.3 };
      v.motion.yawRate = 0;
      this.booms.push({ v, by });
    }
    return dealt;
  }

  takeBooms(): { v: ServerVehicle; by: string }[] {
    const b = this.booms;
    this.booms = [];
    return b;
  }

  /** Blast reach: the hull point nearest `p`. */
  closestPoint(v: ServerVehicle, p: Vec3): Vec3 {
    const m = v.motion;
    return hullClosestPoint(hullAt(v.id, m.pos, m.yaw, m.pitch, m.roll), p);
  }

  record(nowMs: number): void {
    for (const v of this.list) {
      const m = v.motion;
      v.history.record({
        ms: nowMs,
        pos: m.pos,
        yaw: m.yaw,
        pitch: m.pitch,
        roll: m.roll,
        condition: v.condition,
      });
    }
  }

  snapshot(): SnapshotVehicle[] {
    return this.list.map((v) => ({
      id: v.id,
      m: motionToWire(v.motion),
      hp: v.health,
      st: VEHICLE_STATES.indexOf(v.condition),
    }));
  }
}
