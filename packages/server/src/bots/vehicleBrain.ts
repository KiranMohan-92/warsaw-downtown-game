import {
  BOT,
  driveComponents,
  driveRoute,
  hashSeed,
  mulberry32,
  HUG_COST,
  nearestDriveNode,
  roomy,
  SEAT_SPEC,
  smoothDriveRoute,
  TRUCK,
  type BotPersonality,
  type DriveGraph,
  type MapDefinition,
  type SeatId,
  type Vec3,
} from '@wd/shared';
import type { BotMemory, BotObservation, BotVehicleView, BotVisiblePlayer } from './types.ts';

/**
 * What a bot does about the trucks this tick (`BehaviorTreeDecisionProvider` merges it):
 * - `walk`: head for a truck (the tree's movement toward `goal`), Interact when in reach;
 * - `ride`: in a passenger seat: the tree aims and shoots, no walking; Interact to get out;
 * - `drive`: at the wheel: these sticks (moveX steers right, moveZ throttle, Jump handbrake).
 */
export type VehiclePlan =
  | { kind: 'walk'; goal: Vec3; interact: boolean }
  | { kind: 'ride'; interact: boolean }
  | {
      kind: 'drive';
      moveX: number;
      moveZ: number;
      handbrake: boolean;
      interact: boolean;
      /** Where to look (the road ahead, or the enemy being rammed). */
      look: Vec3;
    };

const wrap = (a: number): number => {
  let r = (a + Math.PI) % (Math.PI * 2);
  if (r < 0) r += Math.PI * 2;
  return r - Math.PI;
};
const dist2 = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The point `look` metres ahead on a route: the first waypoint if it is that far, else that far
 * along the legs after it (the arc beyond the first waypoint makes up the rest).
 */
export function pursuitPoint(pos: Vec3, route: readonly Vec3[], look: number): Vec3 | null {
  const first = route[0];
  if (!first) return null;
  let left = look - dist2(pos, first);
  if (left <= 0) return first;
  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i]!;
    const b = route[i + 1]!;
    const len = dist2(a, b);
    if (len >= left) {
      const t = left / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t };
    }
    left -= len;
  }
  return route.at(-1)!;
}

/**
 * The drive-graph nodes other trucks stand on (the graph only knows the static world): under
 * each body and a truck's width round it. Undefined when there are none.
 */
function blockedBy(
  g: DriveGraph,
  others: readonly BotVehicleView[],
): ((node: number) => boolean) | undefined {
  if (!others.length) return undefined;
  const hw = TRUCK.width / 2 + 1.6;
  const hl = TRUCK.length / 2 + 1.6;
  return (i: number): boolean => {
    const n = g.nodes[i]!;
    return others.some((o) => {
      const dx = n.x - o.pos.x;
      const dz = n.z - o.pos.z;
      const c = Math.cos(o.yaw);
      const sn = Math.sin(o.yaw);
      return Math.abs(dx * c - dz * sn) < hw && Math.abs(dx * sn + dz * c) < hl;
    });
  };
}

/** Heading (forward = (sin, cos)) from a to b. */
const bearing = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.atan2(b.x - a.x, b.z - a.z);

/** The roomy node on `from`'s network nearest `p` (within `reach` m; in `only`, if given). */
function nearestRoomy(
  g: DriveGraph,
  p: { x: number; z: number },
  comp: Int32Array,
  from: number,
  reach = 20,
  only: Uint8Array | null = null,
): number | null {
  const here = comp[from] ?? -1;
  let best: number | null = null;
  let bestD = reach;
  g.nodes.forEach((n, i) => {
    if (comp[i] !== here || !roomy(g, i) || (only && !only[i])) return;
    const d = dist2(n, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Per node, how many of the 5 × 5 grid points round it (8 m square) are roomy: 25 in the open,
 * ~15 down the middle of a lane. Computed once per graph.
 */
const opennessCache = new WeakMap<DriveGraph, Uint8Array>();
function openness(g: DriveGraph): Uint8Array {
  let o = opennessCache.get(g);
  if (o) return o;
  o = new Uint8Array(g.nodes.length);
  const grid = g.grid;
  if (grid) {
    g.nodes.forEach((n, i) => {
      const ix = Math.round((n.x - grid.minX) / g.cell);
      const iz = Math.round((n.z - grid.minZ) / g.cell);
      let k = 0;
      for (let dz = -2; dz <= 2; dz++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = ix + dx;
          const z = iz + dz;
          if (x < 0 || z < 0 || x > grid.nx || z > grid.nz) continue;
          const j = grid.index[z * (grid.nx + 1) + x]!;
          if (j >= 0 && roomy(g, j)) k++;
        }
      o[i] = k;
    });
  }
  opennessCache.set(g, o);
  return o;
}

/** Per node, 1 if it lies in one of the map's truck lanes (cached per graph and lane set). */
const laneCache = new WeakMap<DriveGraph, { lanes: unknown; mask: Uint8Array }>();
function laneMask(g: DriveGraph, lanes: MapDefinition['truckLanes']): Uint8Array | null {
  if (!lanes?.length) return null;
  const hit = laneCache.get(g);
  if (hit && hit.lanes === lanes) return hit.mask;
  const mask = Uint8Array.from(g.nodes, (n) =>
    lanes.some((r) => n.x >= r.x0 && n.x <= r.x1 && n.z >= r.z0 && n.z <= r.z1) ? 1 : 0,
  );
  laneCache.set(g, { lanes, mask });
  return mask;
}

/** Each drive graph's connected networks, computed once (roam goals stay reachable). */
const components = new WeakMap<DriveGraph, Int32Array>();
const componentsOf = (g: DriveGraph): Int32Array => {
  let c = components.get(g);
  if (!c) components.set(g, (c = driveComponents(g)));
  return c;
};

/** Where a seat is boarded (world): beside its door / its side of the bed. */
function accessPoint(v: BotVehicleView, seat: SeatId): Vec3 {
  const s = SEAT_SPEC[seat];
  const side = s.hip.x > 0 ? 1 : -1;
  const lx = side * (TRUCK.width / 2 + 0.6);
  const lz = s.hip.z;
  const c = Math.cos(v.yaw);
  const sn = Math.sin(v.yaw);
  return { x: v.pos.x + lx * c + lz * sn, y: v.pos.y, z: v.pos.z - lx * sn + lz * c };
}

/**
 * Where to walk next to board `seat` from `self`: straight to the door from its own side;
 * from the far side, round the nearer end of the truck first (the walking route doesn't know
 * the truck is there, and pushing against its flank gets nowhere).
 */
export function walkRound(v: BotVehicleView, seat: SeatId, self: Vec3, door: Vec3): Vec3 {
  const c = Math.cos(v.yaw);
  const sn = Math.sin(v.yaw);
  const dx = self.x - v.pos.x;
  const dz = self.z - v.pos.z;
  // World → local (local +X = (cos, −sin), +Z = (sin, cos)).
  const lx = dx * c - dz * sn;
  const lz = dx * sn + dz * c;
  const hw = TRUCK.width / 2;
  const hl = TRUCK.length / 2;
  const side = SEAT_SPEC[seat].hip.x > 0 ? 1 : -1;
  if (Math.sign(lx) === side && Math.abs(lx) > hw) return door;
  const end = lz >= 0 ? 1 : -1;
  const at = (x: number, z: number): Vec3 => ({
    x: v.pos.x + x * c + z * sn,
    y: v.pos.y,
    z: v.pos.z - x * sn + z * c,
  });
  // Past the end already: to the corner on the door's side; else along our side to the end.
  if (Math.abs(lz) > hl + 0.5) return at(side * (hw + 0.8), end * (hl + 1.2));
  return at(-side * (hw + 0.8), end * (hl + 1.2));
}

/**
 * The bot side of the trucks: riding along (rushers and flankers love it), then driving — a
 * route on the drive graph to the hunt's goal (a memory, a flank point, a roam spot), pure
 * pursuit along it, slowing for turns, backing out when stuck, getting out to fight when the
 * enemy is close or the truck is beaten; rushers ram enemies on foot. Every action is a button
 * or a stick on the bot's ordinary input: the server seats it and steps the truck from them.
 * Its random stream is its own, so bots on maps without trucks play exactly as before.
 */
export class VehicleBrain {
  private readonly rng: () => number;
  private nextTryAt = 0;
  /** The truck being walked to (id) and until when (ms). */
  private walkingTo: number | null = null;
  private walkUntil = 0;
  /** Whether this approach is for the wheel (else a passenger seat): decided once, when set off. */
  private walkDrive = false;
  private interactPressed = false;
  private stillSince = 0;
  private seatKey: string | null = null;
  private seatVehicle: number | null = null;
  // Driving.
  private route: Vec3[] = [];
  private routeGoal: Vec3 | null = null;
  private routeAt = 0;
  private stuckSince = 0;
  private reverseUntil = 0;
  private reverseFrom = 0;
  private lanes: MapDefinition['truckLanes'];
  private huntEnd: Vec3 | null = null;
  private backOuts: number[] = [];
  private roamGoal: Vec3 | null = null;
  /** Why the last drive decision was made (tests and probes). */
  readonly debug: { reason: string; routeLength: number; goal?: { x: number; z: number } } = {
    reason: '',
    routeLength: 0,
  };

  constructor(
    seed: number,
    private readonly persona: BotPersonality | null,
  ) {
    this.rng = mulberry32(hashSeed(seed, 0x7e41c1e));
  }

  /** The plan for this tick, or null (the ordinary tree on foot). */
  plan(
    obs: BotObservation,
    target: BotVisiblePlayer | null,
    memory: BotMemory | null,
  ): VehiclePlan | null {
    const seat = obs.self.seat;
    const key = seat ? `${seat.vehicle}:${seat.seat}` : null;
    this.seatVehicle = seat?.vehicle ?? null;
    if (key !== this.seatKey) {
      // Just got in (or moved seats): the clocks start now.
      this.seatKey = key;
      this.stillSince = obs.nowMs;
      this.stuckSince = 0;
      this.reverseUntil = 0;
      this.backOuts = [];
      this.routeGoal = null;
    }
    if (!seat) return this.onFoot(obs, target);
    const v = (obs.vehicles ?? []).find((x) => x.id === seat.vehicle);
    if (!v) return { kind: 'ride', interact: this.press(true) };
    this.walkingTo = null;
    if (seat.seat === 'driver') return this.drive(obs, v, target, memory);
    return this.ride(obs, v, target);
  }

  /**
   * The truck we ride in or are walking to board: its crew is a truce (the server never lets a
   * crew hurt each other), so they are not targets.
   */
  truce(): number | null {
    return this.seatVehicle ?? this.walkingTo;
  }

  /** A press edge: pressed this tick only if it wasn't last tick. */
  private press(want: boolean): boolean {
    const p = want && !this.interactPressed;
    this.interactPressed = p;
    return p;
  }

  private onFoot(obs: BotObservation, target: BotVisiblePlayer | null): VehiclePlan | null {
    this.interactPressed = false;
    const now = obs.nowMs;
    const self = obs.self.pos;
    // Someone close to fight: no detours (unless they sit in the truck we'd board: a truce).
    if (
      target &&
      dist2(self, target.pos) < BOT.vehicle.fightRange &&
      (target.vehicle === undefined || target.vehicle !== this.boardable(obs)?.id)
    ) {
      this.walkingTo = null;
      this.debug.reason = 'foot:fight';
      return null;
    }
    let v =
      this.walkingTo !== null
        ? (obs.vehicles ?? []).find((x) => x.id === this.walkingTo)
        : undefined;
    if (v && (now > this.walkUntil || !this.wanted(v))) {
      this.walkingTo = null;
      v = undefined;
      this.nextTryAt = now + BOT.vehicle.retrySeconds * 1000;
    }
    if (!v) {
      if (now < this.nextTryAt || !this.persona) {
        this.debug.reason = 'foot:wait';
        return null;
      }
      this.nextTryAt = now + BOT.vehicle.retrySeconds * 1000 * (0.5 + this.rng());
      const near = (obs.vehicles ?? [])
        .filter((x) => this.wanted(x) && dist2(self, x.pos) < BOT.vehicle.walkRange)
        .sort((a, b) => dist2(self, a.pos) - dist2(self, b.pos))[0];
      if (!near) {
        this.debug.reason = 'foot:none';
        return null;
      }
      const drive = near.free.includes('driver') && this.rng() < this.persona.drive;
      if (!drive && this.rng() >= this.persona.ride) {
        // Not this time: think again soon (a truck nearby is a standing offer).
        this.nextTryAt = now + BOT.vehicle.declineSeconds * 1000;
        this.debug.reason = 'foot:declined';
        return null;
      }
      if (!drive && !near.free.some((s) => s !== 'driver')) return null;
      this.walkingTo = near.id;
      this.walkDrive = drive;
      this.walkUntil = now + 12_000;
      v = near;
    }
    // The seat we aim for: the wheel if it's free and we drive, else the nearest passenger seat.
    // As decided when we set off (the drive and ride rolls are the personality's odds).
    const wantDrive = this.walkDrive && v.free.includes('driver');
    const seat: SeatId = wantDrive
      ? 'driver'
      : (v.free
          .filter((s) => s !== 'driver')
          .sort((a, b) => dist2(self, accessPoint(v, a)) - dist2(self, accessPoint(v, b)))[0] ??
        'driver');
    const door = accessPoint(v, seat);
    const reach = dist2(self, door) < 1.2;
    const goal = reach ? door : walkRound(v, seat, self, door);
    this.debug.reason = `foot:walk ${seat} ${dist2(self, goal).toFixed(1)}`;
    return { kind: 'walk', goal, interact: this.press(reach) };
  }

  /** The truck we are walking to, or the nearest one worth boarding. */
  private boardable(obs: BotObservation): BotVehicleView | undefined {
    const all = obs.vehicles ?? [];
    if (this.walkingTo !== null) return all.find((x) => x.id === this.walkingTo);
    const self = obs.self.pos;
    return all
      .filter((x) => this.wanted(x) && dist2(self, x.pos) < BOT.vehicle.walkRange)
      .sort((a, b) => dist2(self, a.pos) - dist2(self, b.pos))[0];
  }

  /** A truck worth going for: standing, intact enough, slow, with a seat for us. */
  private wanted(v: BotVehicleView): boolean {
    return (
      v.condition === 'active' &&
      v.health > BOT.vehicle.bailHealth &&
      v.speed < 3 &&
      v.free.length > 0
    );
  }

  private ride(
    obs: BotObservation,
    v: BotVehicleView,
    target: BotVisiblePlayer | null,
  ): VehiclePlan {
    const now = obs.nowMs;
    if (v.speed > 0.5 || target) this.stillSince = now;
    const parked = now - this.stillSince > BOT.vehicle.idleExitSeconds * 1000;
    const bail = v.health <= BOT.vehicle.bailHealth || (!v.hasDriver && parked);
    return { kind: 'ride', interact: this.press(bail || parked) };
  }

  private drive(
    obs: BotObservation,
    v: BotVehicleView,
    target: BotVisiblePlayer | null,
    memory: BotMemory | null,
  ): VehiclePlan {
    const B = BOT.vehicle;
    const now = obs.nowMs;
    const g = obs.drive;
    const rams = this.persona?.ram === true;
    // Bail out: the truck is beaten, we're boxed in, or (not a rammer) the enemy is close.
    this.backOuts = this.backOuts.filter((t) => now - t < B.stuckForgetSeconds * 1000);
    const close = target && dist2(v.pos, target.pos) < B.exitToFight && !rams;
    if (v.health <= B.bailHealth || this.backOuts.length >= B.giveUpAfter || close || !g) {
      this.debug.reason =
        v.health <= B.bailHealth ? 'bail' : close ? 'fight' : !g ? 'nograph' : 'stuck';
      this.backOuts = [];
      return this.stop(v, this.press(v.speed < 6));
    }
    // Where to: ram an enemy on foot (rusher), the hunt's memory, else roam the drive graph.
    let goal: Vec3 | null = null;
    if (target && rams && dist2(v.pos, target.pos) < B.ramRange) goal = target.pos;
    else if (memory) goal = memory.pos;
    if (!goal) {
      if (!this.roamGoal || dist2(v.pos, this.roamGoal) < 8) {
        // An open spot on the truck's own network, far enough away to be worth the drive.
        const comp = componentsOf(g);
        const here = comp[nearestDriveNode(g, v.pos)] ?? -1;
        // On the map's truck lanes if it has them (roomy there); else open ground — a square,
        // not a dead end (room to turn round) — on the truck's own network.
        const lanes = laneMask(g, obs.map.truckLanes);
        const wide = openness(g);
        const open = lanes
          ? (i: number): boolean => comp[i] === here && lanes[i] === 1 && roomy(g, i)
          : (i: number): boolean => comp[i] === here && wide[i]! >= 21;
        // Not where another truck stands (the graph only knows the static world).
        const others = (obs.vehicles ?? []).filter((o) => o.id !== v.id);
        const free = (n: Vec3): boolean => others.every((o) => dist2(o.pos, n) > 10);
        const far = g.nodes.filter(
          (n, i) => open(i) && free(n) && dist2(n, v.pos) > B.roamMinDistance,
        );
        // Ahead of us where possible: a 5 m truck has no room to turn round in a lane.
        const ahead = far.filter((n) => Math.abs(wrap(bearing(v.pos, n) - v.yaw)) < 1.6);
        const nodes = ahead.length ? ahead : far.length ? far : g.nodes.filter((_, i) => open(i));
        const pick = nodes[Math.floor(this.rng() * nodes.length)];
        this.roamGoal = pick ? { ...pick } : null;
      }
      goal = this.roamGoal;
    }
    if (!goal) {
      this.debug.reason = 'nogoal';
      return this.stop(v, false);
    }
    this.debug.goal = { x: goal.x, z: goal.z };
    // Route on the drive graph (refreshed when the goal moves or every few seconds).
    if (!this.routeGoal || dist2(this.routeGoal, goal) > 6 || now - this.routeAt > 3000) {
      const from = nearestDriveNode(g, v.pos);
      // A hunt's goal: the nearest point of the truck lanes (the rest is on foot), else the open
      // ground nearest it (not into the maze's alleys).
      const comp = componentsOf(g);
      const lanes = laneMask(g, obs.map.truckLanes);
      const huntTo =
        memory && goal === memory.pos && lanes
          ? nearestRoomy(g, goal, comp, from, 40, lanes)
          : null;
      const to = huntTo ?? nearestRoomy(g, goal, comp, from) ?? nearestDriveNode(g, goal, 12);
      this.huntEnd = huntTo !== null ? { ...g.nodes[huntTo]! } : null;
      const others = (obs.vehicles ?? []).filter((o) => o.id !== v.id && o.condition !== 'gone');
      const blocked = blockedBy(g, others);
      this.lanes = obs.map.truckLanes;
      const ids = this.routeAhead(g, v, from, to, blocked);
      // Straight legs, not the grid's zigzag: the truck holds its speed down a lane.
      this.route = ids ? smoothDriveRoute(g, ids, blocked) : [];
      this.routeGoal = { ...goal };
      this.routeAt = now;
      if (!ids && !rams) this.roamGoal = null;
    }
    // As near the hunt as the lanes go, and it's farther on: out, and on by foot.
    if (
      this.huntEnd &&
      memory &&
      dist2(v.pos, this.huntEnd) < 6 &&
      dist2(this.huntEnd, memory.pos) > 8
    ) {
      this.debug.reason = 'dismount';
      return this.stop(v, this.press(v.speed < 2));
    }
    // A waypoint is done once we're on it, or past it along the next leg (an overshot corner).
    while (this.route.length > 1) {
      const [p, q] = [this.route[0]!, this.route[1]!];
      const d = dist2(v.pos, p);
      const past = (v.pos.x - p.x) * (q.x - p.x) + (v.pos.z - p.z) * (q.z - p.z) > 0;
      if (d < 2 || (past && d < 6)) this.route.shift();
      else break;
    }
    this.debug.routeLength = this.route.length;
    this.debug.reason = 'drive';
    // Pure pursuit on the path itself: the point a lookahead along it (not the next waypoint
    // past the lookahead, which cuts corners into whatever stands on their inside).
    const look = B.lookahead + v.speed * B.lookaheadPerSpeed;
    let aim = pursuitPoint(v.pos, this.route, look) ?? goal;
    if (rams && target && dist2(v.pos, target.pos) < B.ramRange) aim = target.pos;
    const want = Math.atan2(aim.x - v.pos.x, aim.z - v.pos.z);
    const err = wrap(want - v.yaw);
    const arriving = dist2(v.pos, goal) < 10 && !rams;
    if (arriving && memory === null && !target) this.roamGoal = null;
    let throttle: number;
    let steer = Math.max(-1, Math.min(1, err * 2));
    // Backing out of a dead end, the wheel turned so the nose swings toward the way on (a
    // three-point turn): until it points there, or it backs into something too.
    if (now < this.reverseUntil) {
      const backing = now - this.reverseFrom;
      const aligned = backing > 500 && Math.abs(err) < 0.45;
      const blocked = backing > 700 && v.speed < 0.3;
      if (!aligned && !blocked) {
        return {
          kind: 'drive',
          moveX: steer,
          moveZ: -1,
          handbrake: false,
          interact: false,
          look: aim,
        };
      }
      this.reverseUntil = 0;
    }
    if (Math.abs(err) > 1.9 && v.speed < 4) {
      // Behind us: a reverse turn.
      throttle = -1;
      steer = -steer;
    } else {
      const cruise = arriving ? 4 : B.cruise;
      // Slow for the bend we're in (the truck turns wide): crawl through tight ones…
      let target = cruise * Math.max(0.35, 1 - Math.abs(err) / 1.8);
      // …and brake in time for the corner at the end of this leg.
      const corner = this.route[0];
      const after = this.route[1];
      if (corner && after) {
        const inA = Math.atan2(corner.x - v.pos.x, corner.z - v.pos.z);
        const outA = Math.atan2(after.x - corner.x, after.z - corner.z);
        const turn = Math.abs(wrap(outA - inA));
        const vCorner = Math.min(cruise, Math.max(B.cornerSpeed, cruise * (1 - turn / 2.4)));
        const room = Math.max(0, dist2(v.pos, corner) - 2);
        target = Math.min(target, Math.sqrt(vCorner * vCorner + 2 * B.cornerBrake * room));
      }
      throttle = Math.max(-1, Math.min(1, (target - v.forwardSpeed) * 0.6));
    }
    // Stuck: throttle on and going nowhere.
    if (Math.abs(throttle) > 0.3 && v.speed < B.stuckSpeed) {
      if (!this.stuckSince) this.stuckSince = now;
      else if (now - this.stuckSince > B.stuckSeconds * 1000) {
        this.stuckSince = 0;
        this.reverseFrom = now;
        this.reverseUntil = now + B.reverseSeconds * 1000;
        this.backOuts.push(now);
        this.routeGoal = null;
      }
    } else this.stuckSince = 0;
    return {
      kind: 'drive',
      // Controls: steer = -moveX (moveX right).
      moveX: -steer,
      moveZ: throttle,
      handbrake: false,
      interact: false,
      look: aim,
    };
  }

  /**
   * The route, preferring to set off forward: if the shortest one starts behind the truck (a
   * U-turn it has no room for), go via a point ahead unless that is much longer.
   */
  private routeAhead(
    g: DriveGraph,
    v: BotVehicleView,
    from: number,
    to: number,
    blocked: ((node: number) => boolean) | undefined,
  ): number[] | null {
    // Keep to the truck lanes where there are any: off them costs more (most off tight ground).
    const lanes = laneMask(g, this.lanes);
    const weight = lanes
      ? (i: number, j: number): number =>
          lanes[i] && lanes[j] ? 1 : roomy(g, i) && roomy(g, j) ? 2 : HUG_COST
      : undefined;
    const route = (a: number, b: number): number[] | null => driveRoute(g, a, b, blocked, weight);
    const ids = route(from, to);
    if (!ids || ids.length < 4 || this.persona?.ram) return ids;
    const early = g.nodes[ids[3]!]!;
    if (Math.abs(wrap(bearing(v.pos, early) - v.yaw)) < 1.75) return ids;
    const fx = Math.sin(v.yaw);
    const fz = Math.cos(v.yaw);
    for (const reach of [14, 9]) {
      const via = nearestDriveNode(g, { x: v.pos.x + fx * reach, z: v.pos.z + fz * reach }, 3);
      if (via < 0 || via === from) continue;
      const a = route(from, via);
      const b = route(via, to);
      if (!a || !b) continue;
      if (a.length + b.length < ids.length * 2.5 + 15) return [...a, ...b.slice(1)];
    }
    return ids;
  }

  /** Brake to a stop (and get out once slow enough, if asked). */
  private stop(v: BotVehicleView, interact: boolean): VehiclePlan {
    const look = {
      x: v.pos.x + Math.sin(v.yaw) * 10,
      y: v.pos.y + 1.6,
      z: v.pos.z + Math.cos(v.yaw) * 10,
    };
    return {
      kind: 'drive',
      moveX: 0,
      moveZ: v.forwardSpeed > 0.5 ? -1 : v.forwardSpeed < -0.5 ? 1 : 0,
      handbrake: v.speed > 0.5,
      interact,
      look,
    };
  }
}
