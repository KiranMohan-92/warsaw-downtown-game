import {
  boardSpawn,
  DRONE,
  JAMMER,
  createBoard,
  createJetpacks,
  grantJetpack,
  jetpackRespawned,
  stepJetpacks,
  type JetpackEvent,
  type JetpackItem,
  type Vec3,
  createPickups,
  createRadarState,
  grantRadarCharge,
  healWithMedkit,
  MATCH_NET,
  matchPickupDefs,
  PLAYER,
  type PickupKind,
  radarFull,
  SIM_DT,
  smokeLifetime,
  stepPickups,
  stepRadar,
  stepBoard,
  stepSmoke,
  type BoardEvent,
  type BoardState,
  type GrenadeState,
  type MapDefinition,
  type PhysicsWorld,
  type PlayerInput,
  type RadarState,
  type SnapshotMessage,
  type SmokeCloud,
} from '@wd/shared';
import type { ServerPlayer } from './MatchSim.ts';

/** Shared tactical rules, with the server owning pickup races and every player's charges. */
export class MatchTactics {
  readonly pickups;
  smoke: SmokeCloud[] = [];
  /**
   * Clouds that ran out within the rewind or interpolation window, still ageing: a shot rewound to before they
   * went sees them as the shooter did (`smokeHistory`), and snapshots carry them so the client
   * rewinds the same set. Bots and everything else see only the live `smoke`.
   */
  private spentSmoke: SmokeCloud[] = [];
  private readonly radars = new Map<string, RadarState>();
  private readonly jammed = new Map<string, number>();
  private readonly spotted = new Map<string, { id: string; pos: Vec3; t: number }[]>();
  /** The skateboard (null: none on this map) and where it starts. */
  board: BoardState | null = null;
  private readonly boardHome: BoardState['pos'] | null = null;
  /** Board pickups/drops since the last `takeBoardEvents` (the room announces them). */
  private boardEvents: BoardEvent[] = [];

  /** The match's jetpacks (none: off, or none on this map) and their spots on the floor. */
  jetpacks: JetpackItem[] = [];
  private readonly jetHomes: Vec3[] = [];
  /** Jetpack pickups/drops/spends since the last `takeJetpackEvents`. */
  private jetEvents: JetpackEvent[] = [];
  private readonly castDown: (from: Vec3) => Vec3;

  constructor(
    map: MapDefinition,
    radar: 'uplinks' | 'off',
    physics?: PhysicsWorld,
    opts: { jetpacks?: boolean } = {},
  ) {
    this.pickups = createPickups(matchPickupDefs(map.pickups ?? [], radar));
    const spot = map.skateboard;
    const b = map.bounds;
    // Onto what you would stand on (≤ 30 m down); the point itself if nothing is below.
    this.castDown = (from) => {
      const hit = physics?.castGroundRay({ ...from, y: from.y + 0.5 }, { x: 0, y: -1, z: 0 }, 30);
      return hit ? { ...hit.point } : { ...from };
    };
    if (opts.jetpacks !== false) {
      for (const s of map.jetpacks ?? []) {
        if (s.x < b.minX || s.x > b.maxX || s.z < b.minZ || s.z > b.maxZ) continue;
        this.jetHomes.push(this.castDown(s));
      }
      this.jetpacks = createJetpacks(this.jetHomes);
    }
    if (spot && spot.x >= b.minX && spot.x <= b.maxX && spot.z >= b.minZ && spot.z <= b.maxZ) {
      this.boardHome = boardSpawn(
        spot,
        (from) => physics?.castRay(from, { x: 0, y: -1, z: 0 }, 5) ?? null,
      );
      this.board = createBoard(this.boardHome);
    }
  }

  add(id: string): void {
    this.radars.set(id, createRadarState());
    this.jammed.set(id, 0);
    this.spotted.set(id, []);
  }

  remove(id: string): void {
    this.radars.delete(id);
    this.jammed.delete(id);
    this.spotted.delete(id);
  }

  input(p: ServerPlayer, input: PlayerInput): void {
    const radar = this.radars.get(p.id);
    if (radar && p.state.health > 0) stepRadar(radar, input.buttons, p.state.prevButtons, 0);
  }

  step(players: Iterable<ServerPlayer>): void {
    const before = this.smoke;
    this.smoke = stepSmoke(before, SIM_DT);
    if (this.spentSmoke.length || this.smoke.length !== before.length) {
      for (const c of this.spentSmoke) c.age += SIM_DT;
      for (const c of before) if (!this.smoke.includes(c)) this.spentSmoke.push(c);
      // As far back as anyone rewinds (shots) or draws (the client's adaptive interpolation).
      const back = Math.max(MATCH_NET.maxRewindMs, MATCH_NET.maxInterpDelayMs) / 1000;
      const keep = smokeLifetime() + back + SIM_DT;
      this.spentSmoke = this.spentSmoke.filter((c) => c.age < keep);
    }
    for (const radar of this.radars.values()) radar.live = Math.max(0, radar.live - SIM_DT);
    for (const [id, t] of this.jammed) this.jammed.set(id, Math.max(0, t - SIM_DT));
    for (const [id, marks] of this.spotted) {
      for (const mark of marks) mark.t -= SIM_DT;
      this.spotted.set(
        id,
        marks.filter((mark) => mark.t > 0),
      );
    }
    const all = [...players];
    const aliveIds = new Set(all.filter((p) => p.state.health > 0).map((p) => p.id));
    for (const [id, marks] of this.spotted) {
      this.spotted.set(
        id,
        marks.filter((mark) => aliveIds.has(mark.id)),
      );
    }
    const collectors = all.map((p) => ({
      id: p.id,
      pos: p.state.move.pos,
      // Riding in a vehicle you can't grab a pickup.
      alive: p.state.health > 0 && !p.state.seat,
      takes: (kind: PickupKind) => {
        if (kind === 'medkit') return p.state.health < PLAYER.maxHealth;
        if (kind === 'drone') return !p.bot && p.state.droneCharges < 1;
        const radar = this.radars.get(p.id);
        return radar !== undefined && !radarFull(radar);
      },
    }));
    const byId = new Map(all.map((p) => [p.id, p]));
    for (const event of stepPickups(this.pickups, collectors, SIM_DT)) {
      if (event.kind === 'medkit') {
        const p = byId.get(event.by);
        if (p) p.state.health = healWithMedkit(p.state.health);
        continue;
      }
      if (event.kind === 'drone') {
        const p = byId.get(event.by);
        if (p && !p.bot) p.state.droneCharges = Math.min(1, p.state.droneCharges + 1);
        continue;
      }
      const radar = this.radars.get(event.by);
      if (radar) grantRadarCharge(radar);
    }
    this.stepBoard(all);
    this.stepJets(all);
  }

  /** Jetpack rules: pickups (granted into the move state), drops on death, spends. */
  private stepJets(players: readonly ServerPlayer[]): void {
    if (!this.jetpacks.length) return;
    const events = stepJetpacks(
      this.jetpacks,
      players.map((p) => ({
        id: p.id,
        pos: p.state.move.pos,
        alive: p.state.health > 0,
        jet: p.state.move.jet,
        eligible: !p.state.move.board && !p.state.move.prone,
      })),
      this.castDown,
    );
    for (const e of events) {
      if (e.type !== 'pickup') continue;
      const p = players.find((q) => q.id === e.by);
      if (p) grantJetpack(p.state.move);
    }
    this.jetEvents.push(...events);
    // Read by the measurement harness; never let an unread list grow without bound.
    if (this.jetEvents.length > 64) this.jetEvents.splice(0, this.jetEvents.length - 64);
  }

  takeJetpackEvents(): JetpackEvent[] {
    const out = this.jetEvents;
    this.jetEvents = [];
    return out;
  }

  /** Board rules: pickup / drop, then every player's `move.board` follows the rider. */
  private stepBoard(players: readonly ServerPlayer[]): void {
    const board = this.board;
    if (!board) return;
    const events = stepBoard(
      board,
      players.map((p) => ({
        id: p.id,
        pos: p.state.move.pos,
        alive: p.state.health > 0,
        // Not with a jetpack on your back, nor from a truck seat (a rider takes none: `stepJets`).
        eligible: !p.bot && !p.state.seat && p.state.move.jet === 0,
        prone: p.state.move.prone,
      })),
    );
    this.boardEvents.push(...events);
    for (const p of players) p.state.move.board = board.rider === p.id;
  }

  jam(id: string): void {
    if (this.jammed.has(id)) this.jammed.set(id, JAMMER.radarJam);
  }

  clearSpottedTarget(target: string): void {
    for (const [id, marks] of this.spotted) {
      this.spotted.set(
        id,
        marks.filter((mark) => mark.id !== target),
      );
    }
  }

  markSpotted(pilot: string, spots: readonly { id: string; pos: Vec3 }[]): void {
    const marks = this.spotted.get(pilot);
    if (!marks) return;
    for (const spot of spots) {
      const existing = marks.find((m) => m.id === spot.id);
      if (existing) {
        existing.pos = { ...spot.pos };
        existing.t = DRONE.spotTime;
      } else {
        marks.push({ id: spot.id, pos: { ...spot.pos }, t: DRONE.spotTime });
      }
    }
  }

  /** A new life never keeps the board (a fall out of the world respawns without a death). */
  respawned(id: string): void {
    this.jammed.set(id, 0);
    this.spotted.set(id, []);
    if (this.jetpacks.length)
      this.jetEvents.push(...jetpackRespawned(this.jetpacks, id, this.jetHomes, this.castDown));
    const board = this.board;
    if (!board || board.rider !== id) return;
    board.rider = null;
    // Lost below the map: back to its spot rather than out of reach.
    if (board.pos.y < -5 && this.boardHome) board.pos = { ...this.boardHome };
    this.boardEvents.push({ type: 'drop', by: id, pos: { ...board.pos } });
  }

  takeBoardEvents(): BoardEvent[] {
    const out = this.boardEvents;
    this.boardEvents = [];
    return out;
  }

  popSmoke(g: GrenadeState, physics: PhysicsWorld): void {
    const down = physics.castRay(g.pos, { x: 0, y: -1, z: 0 }, 30);
    this.smoke.push({ id: g.id, pos: { ...(down?.point ?? g.pos) }, age: 0 });
  }

  /** The live clouds plus the recently spent ones (for rewinding: `MatchSim.smokeAt`). */
  smokeHistory(): readonly SmokeCloud[] {
    return this.spentSmoke.length ? [...this.smoke, ...this.spentSmoke] : this.smoke;
  }

  /**
   * No smoke through the results (`MatchSim` stops stepping tactics then, so ages would freeze
   * while snapshot time runs on and clients would draw clouds the server has let go).
   */
  clearSmoke(): void {
    this.smoke = [];
    this.spentSmoke = [];
  }

  reset(): void {
    this.clearSmoke();
    for (const pickup of this.pickups) pickup.cooldown = 0;
    if (this.boardHome) this.board = createBoard(this.boardHome);
    this.boardEvents = [];
    // A new match: all three back at their spots.
    if (this.jetHomes.length) this.jetpacks = createJetpacks(this.jetHomes);
    this.jetEvents = [];
    for (const id of this.radars.keys()) this.add(id);
  }

  snapshot(id: string): NonNullable<SnapshotMessage['tactical']> {
    const jammed = this.jammed.get(id) ?? 0;
    const spotted = this.spotted.get(id) ?? [];
    return {
      // Spent clouds too (within the rewind window): the client rewinds the same set we do.
      smoke: this.smokeHistory().map((c) => ({ ...c, pos: { ...c.pos } })),
      pickups: this.pickups.map((p) => ({ ...p, pos: { ...p.pos } })),
      radar: { ...(this.radars.get(id) ?? createRadarState()) },
      ...(jammed > 0 ? { jammed } : {}),
      ...(spotted.length
        ? { spotted: spotted.map((s) => ({ id: s.id, pos: { ...s.pos }, t: s.t })) }
        : {}),
      ...(this.board ? { board: { pos: { ...this.board.pos }, rider: this.board.rider } } : {}),
      ...(this.jetpacks.length
        ? { jetpacks: this.jetpacks.map((j) => ({ ...j, pos: { ...j.pos } })) }
        : {}),
    };
  }
}
