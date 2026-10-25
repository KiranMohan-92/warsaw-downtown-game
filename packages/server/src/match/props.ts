/**
 * Props trucks break (server-owned): a truck's step reports each prop it broke through
 * (`VehicleProps.hit`, from the shared `stepVehicle`); this smashes it (gone for the match) or
 * knocks it over (a Rapier rigid body in the match's world until it settles, then static again
 * where it lies). Props resting on top of one that goes fall too. Clients never report impacts:
 * they get `prop` events (and the tumbling poses in snapshots) and mirror the static colliders.
 * Everything stays until the next match (`reset`).
 */
import {
  propImpact,
  propPoseToWire,
  roundPropPose,
  SIM_DT,
  VEHICLE_IMPACT,
  type CombatEvent,
  type PhysicsWorld,
  type PropHit,
  type VehicleObstacle,
  type Vec3,
  type VehicleProps,
} from '@wd/shared';

/** A prop with no table entry knocked off its support falls with this mass (kg). */
const FALLING_MASS = 20;

/** A prop's footprint on the ground (nav and drive graphs re-check what lies under it). */
export type PropBox = { minX: number; maxX: number; minZ: number; maxZ: number };

export class MatchProps implements VehicleProps {
  /** Ground under a prop changed (it went, or it settled there): bots' graphs re-check it. */
  onChange?: (box: PropBox) => void;
  /** Every prop went home (a new match): the graphs are exact again. */
  onReset?: () => void;
  /** Knocks per prop this match: each tumble's events and snapshot rows carry its number. */
  private readonly knocks = new Map<number, number>();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly emitEvent: (e: CombatEvent) => void,
    private readonly tick: () => number,
    private readonly vehicleBlockers: () => readonly VehicleObstacle[] = () => [],
  ) {}

  /** Send a prop event (stamped with the prop's knock number) and re-check the ground under it. */
  private emit(e: CombatEvent): void {
    if (e.type === 'prop') {
      if (e.k === 'knock') this.knocks.set(e.id, (this.knocks.get(e.id) ?? 0) + 1);
      const n = this.knocks.get(e.id);
      this.emitEvent(n ? { ...e, n } : e);
      this.changed(e.id);
    } else this.emitEvent(e);
  }

  private changed(id: number): void {
    const b = this.physics.propBounds(id);
    if (b) this.onChange?.({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z });
  }

  /** The server's world loses a broken prop's colliders at once: nothing is left to pass. */
  passed(): boolean {
    return false;
  }

  hit(h: PropHit): void {
    const at = { x: h.point.x, y: h.point.y, z: h.point.z };
    const v = Math.round(h.into * 10) / 10;
    if (h.kind === 'smash') {
      if (!this.physics.removeProp(h.id)) return;
      this.emit({ type: 'prop', id: h.id, k: 'smash', tick: this.tick(), at, v });
      this.drop(this.physics.propsOnTop(h.id), h.vel);
      return;
    }
    const I = VEHICLE_IMPACT;
    const n = h.normal; // out of the prop, toward the truck
    // The launch along the contact (1-D collision with the truck), a share of the truck's own
    // velocity along its bumper, and a bumper lift.
    const vn = (((1 + I.restitution) * I.truckMass) / (I.truckMass + h.mass)) * h.into * h.shove;
    const along = h.vel.x * -n.z + h.vel.z * n.x;
    const vel = {
      x: -n.x * vn + -n.z * along * I.carry,
      y: I.lift * h.into * h.shove,
      z: -n.z * vn + n.x * along * I.carry,
    };
    // A third of the launch goes in at the contact point: an off-centre hit spins the prop.
    const spin = 0.35;
    const base = { x: vel.x * (1 - spin), y: vel.y, z: vel.z * (1 - spin) };
    const j = { x: -n.x * vn * spin * h.mass, y: 0, z: -n.z * vn * spin * h.mass };
    const top = this.physics.propsOnTop(h.id);
    if (!this.physics.knockProp(h.id, h.mass, base, { at, j })) return;
    this.emit({ type: 'prop', id: h.id, k: 'knock', tick: this.tick(), at, v });
    this.drop(top, h.vel);
  }

  /**
   * Props that stood on one that just went: a carton or a bag (smash class) bursts with the stack
   * (a pallet load doesn't drop in one piece onto the truck's path); anything else falls,
   * dragged a little by the truck.
   */
  private drop(ids: readonly number[], truck: Vec3): void {
    for (const j of ids) {
      const inst = this.physics.prop(j);
      if (!inst) continue;
      const spec = propImpact(inst);
      const top = this.physics.propsOnTop(j);
      if (spec?.kind === 'smash') {
        if (!this.physics.removeProp(j)) continue;
        const at = { x: inst.pos.x, y: inst.pos.y + 0.2, z: inst.pos.z };
        this.emit({ type: 'prop', id: j, k: 'smash', tick: this.tick(), at });
      } else {
        const vel = { x: truck.x * 0.2, y: 0, z: truck.z * 0.2 };
        if (!this.physics.knockProp(j, spec?.mass ?? FALLING_MASS, vel)) continue;
        this.emit({ type: 'prop', id: j, k: 'knock', tick: this.tick(), quiet: true });
      }
      this.drop(top, truck);
    }
  }

  /** One tick of the tumbling props: settled ones are static again (and announced). */
  step(): void {
    const { settled, lost } = this.physics.stepProps(SIM_DT, this.vehicleBlockers());
    const tick = this.tick();
    for (const s of settled)
      this.emit({ type: 'prop', id: s.id, k: 'settle', tick, p: propPoseToWire(s.pose) });
    for (const id of lost) this.emit({ type: 'prop', id, k: 'gone', tick, quiet: true });
  }

  /** The tumbling props for a snapshot (absent: none). */
  snapshot(): number[][] | undefined {
    const moving = this.physics.movingProps();
    if (!moving.length) return undefined;
    return moving.map(({ id, pose }) => [
      id,
      this.knocks.get(id) ?? 0,
      ...propPoseToWire(roundPropPose(pose.pos, pose.quat)),
    ]);
  }

  /**
   * What a joiner (or a reconnecting client, whose props may be from an older match) needs:
   * everything home, then every prop not where the map put it.
   */
  restore(): CombatEvent[] {
    const out: CombatEvent[] = [{ type: 'propsReset' }];
    const tick = this.tick();
    for (let id = 0; id < this.physics.propCount; id++) {
      if (!this.physics.propChanged(id)) continue;
      const state = this.physics.propState(id);
      const n = this.knocks.get(id);
      const nth = n ? { n } : {};
      if (state === 'gone') out.push({ type: 'prop', id, k: 'gone', tick, quiet: true, ...nth });
      else if (state === 'moving')
        out.push({ type: 'prop', id, k: 'knock', tick, quiet: true, ...nth });
      else {
        const inst = this.physics.prop(id)!;
        const p = propPoseToWire({ pos: inst.pos, quat: inst.quat });
        out.push({ type: 'prop', id, k: 'settle', tick, p, quiet: true, ...nth });
      }
    }
    return out;
  }

  /** A new match: every prop back home (clients are told). */
  reset(): void {
    this.knocks.clear();
    if (!this.physics.resetProps().length) return;
    this.onReset?.();
    this.emit({ type: 'propsReset' });
  }
}
