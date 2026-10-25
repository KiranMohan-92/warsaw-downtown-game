import * as THREE from 'three';
import {
  JETPACK,
  JetMode,
  jetSputter,
  SnapFlag,
  type JetpackItem,
  type MoveState,
  type PlayerEvent,
  type Vec3,
} from '@wd/shared';
import type { Soldier } from '../render/soldiers.ts';
import { Spring } from '../feel/spring.ts';
import { JetpackFx } from './jetpackFx.ts';
import { JetpackHud } from './JetpackHud.ts';
import { REMOTE_VOICES, type JetpackSound } from './jetpackAudio.ts';
import { fallbackJetpack, JETPACK_ANCHORS, type JetpackModel } from './jetpackModel.ts';

/** Another player as drawn this frame (online: interpolated poses). */
export interface JetFlyer {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** `SnapFlag` bits (Jetpack / JetFlight / JetThrust). */
  f: number;
  alive: boolean;
  /** Their soldier (nozzles from the worn pack), else the pose places them. */
  soldier: Soldier | null;
}

/**
 * The flyers for a frame from the remote players actually drawn (live, or the kill cam's replay:
 * the caller passes the same list the soldiers are drawn from), into `out`.
 */
export function jetFlyersOf(
  players: readonly {
    id: string;
    pose: { x: number; y: number; z: number; yaw: number; f: number; hp: number };
  }[],
  soldierOf: (id: string) => Soldier | null,
  out: JetFlyer[],
): JetFlyer[] {
  out.length = 0;
  for (const r of players)
    out.push({
      id: r.id,
      x: r.pose.x,
      y: r.pose.y,
      z: r.pose.z,
      yaw: r.pose.yaw,
      f: r.pose.f,
      alive: r.pose.hp > 0,
      soldier: soldierOf(r.id),
    });
  return out;
}

export interface JetFrame {
  dt: number;
  items: readonly JetpackItem[];
  /** Our own state (the sim's, this frame) and where it is drawn. */
  self: MoveState;
  selfAlive: boolean;
  /** Drawn feet (interpolated) and view yaw. */
  selfFeet: Vec3;
  yaw: number;
  /** Our soldier while the camera is outside the head (cinematic), else null. */
  selfSoldier: Soldier | null;
  /** The camera is in the head (first person): our own pack's flames come from the body. */
  firstPerson: boolean;
  others: readonly JetFlyer[];
  /** The listener (camera) for distances and panning. */
  ear: THREE.Vector3;
  earYaw: number;
  sound: JetpackSound | null;
  /** Ground below a point (m), null when nothing is there (a ray down). */
  groundBelow: (p: Vec3) => number | null;
  /** The key that lights it (Jump), for the HUD hint. */
  jumpKey: string;
}

const UP = new THREE.Vector3(0, 1, 0);

const BEAM_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }
`;
const BEAM_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vFacing;
  void main() {
    float up = vUv.y;
    float fade = pow(1.0 - up, 2.2) * smoothstep(0.0, 0.04, up);
    float soft = pow(vFacing, 2.0);
    // Motes: thin bright flecks rising slowly round the column.
    float m = fract(up * 7.0 - uTime * 0.18 + floor(vUv.x * 9.0) * 0.37);
    float mote = smoothstep(0.96, 1.0, m) * step(0.55, fract(sin(floor(vUv.x * 9.0) * 12.9) * 43.7));
    vec3 col = vec3(1.0, 0.68, 0.28) * (0.22 * fade * soft + 0.9 * mote * fade);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
/** The pickup reads from across the square: shown a little larger than worn. */
const PICKUP_SCALE = 1.5;
/** Exhaust power while hovering (no thrust input): a steady, readable flame. */
const HOVER_POWER = 0.45;

/** The ray down starts this far above the point (so a point on the floor still finds it). */
const GROUND_PROBE_LIFT = 0.05;
const DOWN_DIR = { x: 0, y: -1, z: 0 };

/**
 * How far the ground is below `p` (m), null when nothing is within 40 m: a ray down from just
 * above `p`, the lift taken back off the distance (else the exhaust's light pool sat 5 cm too
 * low and the floor hid it; Codex P2).
 */
export function groundBelowAt(
  cast: (from: Vec3, dir: Vec3, max: number) => { distance: number } | null,
  p: Vec3,
): number | null {
  const hit = cast({ x: p.x, y: p.y + GROUND_PROBE_LIFT, z: p.z }, DOWN_DIR, 40);
  return hit ? hit.distance - GROUND_PROBE_LIFT : null;
}

/** A remote flyer's engine is running (flying, not the out-of-fuel drop): exhaust + roar. */
export const remotePowered = (f: number): boolean =>
  (f & SnapFlag.JetFlight) !== 0 && (f & SnapFlag.JetDrop) === 0;

/**
 * Everything the jetpack shows and plays, from the sim's state (presentation only): the pickups
 * on their pedestals, exhaust on every flyer (soldiers' worn packs; our own from the body in first
 * person), dust under low flyers and the landing puff, the HUD module, the first-person feel
 * (bank, FOV kick, shake), and the sound — ours and, spatialized, everyone else's.
 */
export class JetpackPresenter {
  readonly group = new THREE.Group();
  readonly fx = new JetpackFx();
  readonly hud: JetpackHud;
  private model: JetpackModel = fallbackJetpack();
  private readonly pedestals: { root: THREE.Group; ring: THREE.Mesh; home: Vec3 }[] = [];
  private readonly packs: THREE.Group[] = [];
  private time = 0;
  private readonly beamTime = { value: 0 };
  // Own feel and sound state.
  private thrust = 0;
  private readonly bank = new Spring(10, 0.8);
  private fovKick = 0;
  private shakeAmp = 0;
  private lastMode = 0;
  private lastBeep = -1;
  private wasDip = false;
  private readonly prevFlags = new Map<string, number>();
  private readonly remoteThrust = new Map<string, number>();
  private readonly nozzlesTmp: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly dirTmp = new THREE.Vector3();
  /** Called when we pick one up (the game's banner). */
  onPickup: (() => void) | null = null;

  private readonly mat = {
    pedestal: new THREE.MeshStandardMaterial({ color: '#2a2f35', roughness: 0.45, metalness: 0.7 }),
    rim: new THREE.MeshStandardMaterial({
      color: '#1b3a44',
      emissive: new THREE.Color('#ffb54a'),
      emissiveIntensity: 1.6,
    }),
    ring: new THREE.MeshBasicMaterial({
      color: '#ffb54a',
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    ringIdle: new THREE.MeshBasicMaterial({
      color: '#ffb54a',
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    // A soft column: brightest at the pedestal, fading up and out at its edges, with faint
    // motes drifting up it (one shader for every beam).
    beam: new THREE.ShaderMaterial({
      name: 'jetpack:beam',
      uniforms: { uTime: this.beamTime },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  };
  private readonly geo = {
    pedestal: new THREE.CylinderGeometry(0.5, 0.58, 0.12, 6),
    rim: new THREE.TorusGeometry(0.52, 0.018, 6, 6),
    ring: new THREE.RingGeometry(0.62, 0.8, 36),
    beam: new THREE.CylinderGeometry(0.16, 0.42, 6, 16, 1, true),
  };

  constructor(hudHost: HTMLElement, homes: readonly Vec3[]) {
    this.group.name = 'jetpack';
    this.group.add(this.fx.group);
    this.hud = new JetpackHud(hudHost);
    for (const home of homes) {
      const root = new THREE.Group();
      root.position.set(home.x, home.y, home.z);
      const ped = new THREE.Mesh(this.geo.pedestal, this.mat.pedestal);
      ped.position.y = 0.06;
      ped.castShadow = true;
      const rim = new THREE.Mesh(this.geo.rim, this.mat.rim);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.125;
      const ring = new THREE.Mesh(this.geo.ring, this.mat.ring);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      root.add(ped, rim, ring);
      this.group.add(root);
      this.pedestals.push({ root, ring, home });
    }
    // One pack group per pack in the match (3), plus a hidden spare: every program in warm-up.
    for (let i = 0; i < Math.max(4, homes.length + 1); i++) this.packs.push(this.makePack());
    // Templates for warm-up: the idle ring material too.
    const idle = new THREE.Mesh(this.geo.ring, this.mat.ringIdle);
    idle.visible = false;
    this.group.add(idle);
  }

  private makePack(): THREE.Group {
    const g = new THREE.Group();
    const m = new THREE.Mesh(this.model.geometry, this.model.material);
    m.castShadow = true;
    m.name = 'jetpack:pickup';
    const beam = new THREE.Mesh(this.geo.beam, this.mat.beam);
    beam.position.y = 3;
    g.add(m, beam);
    g.visible = false;
    this.group.add(g);
    return g;
  }

  /** The built model replaces the stand-in (before warm-up). */
  useModel(model: JetpackModel): void {
    this.model = model;
    for (const g of this.packs) {
      const m = g.children[0] as THREE.Mesh;
      m.geometry = model.geometry;
      m.material = model.material;
    }
  }

  /** The kit soldiers wear (the same mesh and material as the pickups). */
  get soldierKit(): {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    nozzles: [number, number, number][];
  } {
    const a = this.model.anchors ?? JETPACK_ANCHORS;
    return {
      geometry: this.model.geometry,
      material: this.model.material,
      nozzles: [a.nozzleL, a.nozzleR],
    };
  }

  /** Our own events (the sim's): ignition, cut-off, the drop's touchdown. */
  event(e: PlayerEvent, feet: Vec3, sound: JetpackSound | null): void {
    if (e.type === 'jetIgnite') {
      sound?.ignite();
      this.shakeAmp = Math.max(this.shakeAmp, 1);
      this.bank.kick(0.6);
    } else if (e.type === 'jetCutoff') {
      sound?.cutoff();
      this.shakeAmp = Math.max(this.shakeAmp, 0.8);
    } else if (e.type === 'jetLand') {
      sound?.land(e.impactSpeed);
      this.fx.landPuff(new THREE.Vector3(feet.x, feet.y, feet.z), 1);
      this.shakeAmp = Math.max(this.shakeAmp, 1.4);
    }
  }

  /** Camera roll (rad) to add: the bank into a sideways thrust. */
  get roll(): number {
    return this.bank.value;
  }

  /** FOV multiplier: a slight kick under thrust. */
  get fovScale(): number {
    return 1 + 0.045 * this.fovKick;
  }

  /** Camera shake offsets (rad) this frame. */
  shake(t: number): { pitch: number; yaw: number } {
    const a = this.shakeAmp * 0.004;
    return { pitch: a * Math.sin(t * 57), yaw: a * Math.sin(t * 43 + 1.3) };
  }

  frame(f: JetFrame): void {
    const dt = f.dt;
    this.time += dt;
    this.fx.begin(dt, f.ear);
    this.beamTime.value += dt;
    this.drawItems(f.items, dt);
    // --- us -----------------------------------------------------------------------------
    const m = f.self;
    const flying = f.selfAlive && m.jet === JetMode.Flying;
    const power = flying ? jetSputter(m.jetFuel) : 0;
    const target = flying ? (m.jetThrust ? 1 : HOVER_POWER) : 0;
    this.thrust += (target - this.thrust) * Math.min(1, dt * 9);
    this.fovKick += ((flying && m.jetThrust ? 1 : 0) - this.fovKick) * Math.min(1, dt * 4);
    // Bank into the sideways thrust (velocity across the view), like a rotor tilting.
    const right = { x: Math.cos(f.yaw), z: -Math.sin(f.yaw) };
    const side = m.vel.x * right.x + m.vel.z * right.z;
    const bankTarget = flying ? THREE.MathUtils.clamp(-side * 0.012, -0.085, 0.085) : 0;
    this.bank.update(bankTarget, dt);
    const fullThrust = flying && m.jetThrust ? 0.35 : 0;
    this.shakeAmp = Math.max(fullThrust * (power < 1 ? 1.6 : 1), this.shakeAmp - dt * 2.5);
    const dip = power > 0 && power < JETPACK.sputterThrust - 1e-6;
    if (m.jet !== this.lastMode) {
      if (this.lastMode === JetMode.None && m.jet === JetMode.Worn) {
        f.sound?.pickup();
        this.onPickup?.();
      }
      this.lastMode = m.jet;
      this.lastBeep = -1;
    }
    if (flying) {
      // Low fuel: beeps (twice a second, four times in the last second), coughs on cut-outs.
      if (m.jetFuel <= JETPACK.sputterTime) {
        const rate = m.jetFuel <= 1 ? 4 : 2;
        const n = Math.floor(m.jetFuel * rate);
        if (n !== this.lastBeep) {
          this.lastBeep = n;
          f.sound?.beep(1 - m.jetFuel / JETPACK.sputterTime);
        }
      }
      if (dip && !this.wasDip) f.sound?.cough();
    }
    f.sound?.setOwn(flying, this.thrust, power || 1);
    // Our own exhaust: from the worn pack when our soldier is drawn, else from the body.
    const own = this.ownNozzles(f);
    if (own && flying) {
      const below = f.groundBelow(f.selfFeet);
      for (const n of own) {
        this.fx.nozzle(
          n,
          this.dirTmp,
          this.thrust * power,
          dt,
          below === null ? null : below + (n.y - f.selfFeet.y),
        );
        if (dip && !this.wasDip) this.fx.sputter(n, this.dirTmp);
      }
    }
    this.wasDip = dip;
    // --- everyone else ---------------------------------------------------------------------
    let voice = 0;
    const order = f.others
      .filter((o) => o.alive && remotePowered(o.f))
      .map((o) => ({ o, d: Math.hypot(o.x - f.ear.x, o.y - f.ear.y, o.z - f.ear.z) }))
      .sort((a, b) => a.d - b.d);
    for (const o of f.others) {
      const was = this.prevFlags.get(o.id) ?? 0;
      const lit = (o.f & SnapFlag.JetFlight) !== 0;
      const d = Math.hypot(o.x - f.ear.x, o.y - f.ear.y, o.z - f.ear.z);
      if (lit && (was & SnapFlag.JetFlight) === 0 && o.alive) f.sound?.ignite(d);
      // Out of fuel: the engine dies at the cutoff, then the drop is silent until the thud.
      if (remotePowered(was) && !remotePowered(o.f) && lit && o.alive) f.sound?.cutoff(d);
      if (!lit && (was & SnapFlag.JetFlight) !== 0 && o.alive) {
        f.sound?.land(6, d);
        this.fx.landPuff(new THREE.Vector3(o.x, o.y, o.z), 0.8);
      }
      this.prevFlags.set(o.id, o.f);
      if (!remotePowered(o.f) || !o.alive) {
        this.remoteThrust.delete(o.id);
        continue;
      }
      const tgt = (o.f & SnapFlag.JetThrust) !== 0 ? 1 : HOVER_POWER;
      const th =
        (this.remoteThrust.get(o.id) ?? tgt) +
        (tgt - (this.remoteThrust.get(o.id) ?? tgt)) * Math.min(1, dt * 9);
      this.remoteThrust.set(o.id, th);
      const nz = this.flyerNozzles(o);
      const below = f.groundBelow({ x: o.x, y: o.y, z: o.z });
      for (const n of nz)
        this.fx.nozzle(n, this.dirTmp, th, dt, below === null ? null : below + (n.y - o.y));
    }
    for (const { o, d } of order) {
      if (voice >= REMOTE_VOICES) break;
      const bearing = Math.atan2(-(o.x - f.ear.x), -(o.z - f.ear.z)) - f.earYaw;
      const pan = -Math.sin(bearing);
      f.sound?.setRemote(voice++, true, this.remoteThrust.get(o.id) ?? 0.5, d, pan);
    }
    for (; voice < REMOTE_VOICES; voice++) f.sound?.setRemote(voice, false, 0, 0, 0);
    for (const id of [...this.prevFlags.keys()])
      if (!f.others.some((o) => o.id === id)) this.prevFlags.delete(id);
    this.fx.end(dt);
    // --- HUD ---------------------------------------------------------------------------------
    const alt = m.jet === JetMode.None ? null : f.groundBelow(f.selfFeet);
    this.hud.update(
      f.selfAlive && m.jet !== JetMode.None
        ? {
            mode: m.jet,
            fuel: m.jetFuel,
            alt,
            glow: f.firstPerson ? this.thrust * power : 0,
            key: f.jumpKey,
          }
        : null,
    );
  }

  /** Our nozzles this frame (world) and the exhaust direction in `dirTmp`. */
  private ownNozzles(f: JetFrame): THREE.Vector3[] | null {
    if (f.selfSoldier?.nozzles(this.nozzlesTmp, this.dirTmp)) return this.nozzlesTmp;
    // First person: where the pack hangs on our back (behind the body, below the shoulders).
    const back = { x: Math.sin(f.yaw), z: Math.cos(f.yaw) };
    const right = { x: Math.cos(f.yaw), z: -Math.sin(f.yaw) };
    const a = this.model.anchors;
    const lift = 1.33; // pack origin above the feet (upper back)
    const behind = 0.17;
    const p = f.selfFeet;
    [a.nozzleL, a.nozzleR].forEach((n, i) => {
      this.nozzlesTmp[i]!.set(
        p.x + back.x * (behind + n[2]) + right.x * n[0],
        p.y + lift + n[1],
        p.z + back.z * (behind + n[2]) + right.z * n[0],
      );
    });
    this.dirTmp.copy(UP).negate();
    return this.nozzlesTmp;
  }

  private flyerNozzles(o: JetFlyer): THREE.Vector3[] {
    if (o.soldier?.nozzles(this.nozzlesTmp, this.dirTmp)) return this.nozzlesTmp;
    return this.ownNozzles({
      selfSoldier: null,
      yaw: o.yaw,
      selfFeet: { x: o.x, y: o.y, z: o.z },
    } as JetFrame)!;
  }

  /** The pickups: free packs hover over their spot (or lie where a carrier fell). */
  private drawItems(items: readonly JetpackItem[], dt: number): void {
    let n = 0;
    for (const p of this.pedestals) p.ring.material = this.mat.ringIdle;
    for (const it of items) {
      if (it.spent || it.carrier !== null) continue;
      const g = this.packs[n++];
      if (!g) break;
      g.visible = true;
      const pack = g.children[0]!;
      const atHome = this.pedestals.find(
        (p) => Math.hypot(p.home.x - it.pos.x, p.home.z - it.pos.z) < 0.6,
      );
      if (atHome) atHome.ring.material = this.mat.ring;
      g.position.set(it.pos.x, it.pos.y, it.pos.z);
      pack.position.y = (atHome ? 1.0 : 0.6) + Math.sin(this.time * 2 + it.id) * 0.05;
      pack.scale.setScalar(PICKUP_SCALE);
      pack.rotation.y += dt * 0.7;
      pack.rotation.x = 0.12;
    }
    for (; n < this.packs.length; n++) this.packs[n]!.visible = false;
  }
}
