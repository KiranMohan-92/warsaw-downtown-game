import * as THREE from 'three';
import { CINE, type CameraDirector } from './cameraDirector.ts';
import {
  CameraSpline,
  CollisionSmoother,
  collideCamera,
  dist3,
  easeOutCubic,
  follow,
  forwardOf,
  orbitPoint,
  overShoulder,
  set3,
  smootherstep,
  smoothstep,
  type RayCast,
  type V3,
} from './cinematicMath.ts';

/** A body the camera frames: feet position, facing, eye height. */
export interface ShotSubject {
  pos: V3;
  yaw: number;
  pitch: number;
  eye: number;
}

/** A hand-authored camera key of the intro: where the camera is, and what it looks at. */
export interface IntroKey {
  pos: V3;
  look: V3;
}

/**
 * The Market fly-over (map coordinates: the Palace stands at the origin, its tower is the
 * landmark; the Market quarter spans x 38–170, z −62–64 east of it). High over the eastern
 * stalls looking at the tower, low along the stall rows toward the Palace; the path then
 * swings down to the player's own eye.
 */
export const MARKET_INTRO: readonly IntroKey[] = [
  { pos: { x: 172, y: 30, z: 58 }, look: { x: 0, y: 70, z: 0 } },
  { pos: { x: 132, y: 17, z: 22 }, look: { x: 0, y: 55, z: 0 } },
  { pos: { x: 96, y: 13, z: -4 }, look: { x: 20, y: 40, z: -8 } },
];

/** Everything a shot needs from the game this frame (filled in place by the caller). */
export interface ShotInputs {
  dt: number;
  /** The first-person camera this frame: where shots start from and hand back to. */
  fpPos: THREE.Vector3;
  fpQuat: THREE.Quaternion;
  fpFov: number;
  /** The player's FOV setting (vertical degrees, no zoom/sprint): the lens of every shot. */
  baseFov: number;
  /** The local player's body. */
  self: ShotSubject;
  /** Kill cam: the killer (replayed online, live offline); null frames the body instead. */
  killer: ShotSubject | null;
  /** Victory shot: the winner; null = a wide shot from `wide` (a winner who left). */
  winner: ShotSubject | null;
  /**
   * The wide shot's vantage: a pivot in open air above the map (validated by the caller: a
   * pivot in the ground would collide the camera onto itself) and the point it looks at.
   */
  wide: { pivot: V3; look: V3 };
  cast: RayCast;
}

export function blankSubject(): ShotSubject {
  return { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, eye: 1.62 };
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Composes the camera for the director's current moment and writes it into the game camera.
 * Every vector, quaternion and spline is allocated once; `update` allocates nothing.
 */
export class CinematicCamera {
  /** Intro path: the authored keys, an approach behind the player, and their eye. */
  private spline = new CameraSpline(2);
  private lookSpline = new CameraSpline(2);
  private readonly collision = new CollisionSmoother();
  /** Where the camera was when the current moment started (fly-ins blend from it). */
  private readonly startPos = new THREE.Vector3();
  private readonly startQuat = new THREE.Quaternion();
  /** Facing of the subject when the moment started (orbits start behind / in front of it). */
  private startYaw = 0;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly look = new THREE.Vector3();
  private readonly mat = new THREE.Matrix4();
  private readonly want: V3 = { x: 0, y: 0, z: 0 };
  private readonly pivot: V3 = { x: 0, y: 0, z: 0 };
  private readonly hit: V3 = { x: 0, y: 0, z: 0 };
  private readonly dir: V3 = { x: 0, y: 0, z: 0 };
  private readonly v: V3 = { x: 0, y: 0, z: 0 };
  private readonly v3q = new THREE.Quaternion();
  private readonly orbitPos = new THREE.Vector3();
  private readonly killWant = new THREE.Vector3();
  /** Victory: a wall on the fly-in's way made it a cut; the fly-in has taken a step. */
  private flyCut = false;
  private snapNext = false;
  private flying = false;
  private readonly flyTo = new THREE.Vector3();
  /** Victory: on the shot (the fly-in is over), and the eased spot the shot wants. */
  private orbiting = false;
  private readonly vicWant = new THREE.Vector3();
  /** The camera has a pose from last frame to follow on from. */
  private settled = false;
  /** The frame's static ray cast (camera collision). */
  private cast: RayCast = () => null;
  /** Distance from the camera to the player's eye (the body hides when the camera is in it). */
  eyeDistance = 0;

  constructor(private readonly director: CameraDirector) {}

  /**
   * Plan the intro from the player's eye: the authored keys (the Market's; other maps have no
   * intro), an approach point behind and above the player, pulled in front of any wall, and
   * the eye itself.
   */
  planIntro(keys: readonly IntroKey[], eye: V3, yaw: number, pitch: number, cast: RayCast): void {
    const n = keys.length + 2;
    this.spline = new CameraSpline(n);
    this.lookSpline = new CameraSpline(n);
    keys.forEach((k, i) => {
      this.spline.setKey(i, k.pos.x, k.pos.y, k.pos.z);
      this.lookSpline.setKey(i, k.look.x, k.look.y, k.look.z);
    });
    // Approach: 7 m behind and 3 m up, off the walls round the eye, and raised (up to 9 m more)
    // until the swoop down to it from the last authored key is clear — checked once, so the
    // path never pops (a stall canopy over the spawn is flown round, not through).
    for (let lift = 0; lift <= 9; lift += 3) {
      overShoulder(eye, yaw, 0, 7, 1.2, 3 + lift, this.want);
      collideCamera(eye, this.want, cast, this.hit);
      const last = keys[keys.length - 1]?.pos;
      if (!last) break;
      const d = dist3(this.hit, last);
      set3(
        this.dir,
        (last.x - this.hit.x) / d,
        (last.y - this.hit.y) / d,
        (last.z - this.hit.z) / d,
      );
      if (d < 1e-3 || cast(this.hit, this.dir, d) === null) break;
    }
    this.spline.setKey(n - 2, this.hit.x, this.hit.y, this.hit.z);
    forwardOf(yaw, pitch, this.dir);
    this.lookSpline.setKey(
      n - 2,
      eye.x + this.dir.x * 20,
      eye.y + this.dir.y * 20,
      eye.z + this.dir.z * 20,
    );
    this.setIntroEnd(eye, yaw, pitch);
  }

  /** The intro's last key follows the eye (a correction or a step moves it slightly). */
  private setIntroEnd(eye: V3, yaw: number, pitch: number): void {
    const n = this.spline.count;
    this.spline.setKey(n - 1, eye.x, eye.y, eye.z);
    forwardOf(yaw, pitch, this.dir);
    this.lookSpline.setKey(
      n - 1,
      eye.x + this.dir.x * 20,
      eye.y + this.dir.y * 20,
      eye.z + this.dir.z * 20,
    );
    this.spline.update();
    this.lookSpline.update();
  }

  /**
   * Write this frame's shot into `camera` (position, orientation, FOV). Returns false in
   * `play` (the caller's first-person camera stands).
   */
  update(inp: ShotInputs, camera: THREE.PerspectiveCamera): boolean {
    const d = this.director;
    this.cast = inp.cast;
    if (d.mode === 'play') {
      this.settled = false;
      this.eyeDistance = 0;
      return false;
    }
    if (d.takeEntered()) {
      // Every moment starts from wherever the camera is now (first person, or the last shot).
      this.startPos.copy(this.settled ? this.pos : inp.fpPos);
      this.startQuat.copy(this.settled ? this.quat : inp.fpQuat);
      this.collision.reset();
      const subject = d.mode === 'victory' ? inp.winner : d.mode === 'killcam' ? inp.killer : null;
      this.startYaw = (subject ?? inp.self).yaw;
      if (d.mode === 'death' || d.mode === 'orbit') this.startYaw = inp.self.yaw;
      if (d.mode === 'killcam') this.settled = false; // a cut to the killer
      this.flyCut = false;
      this.orbiting = false;
      this.snapNext = false;
      this.flying = false;
    }
    let fov = inp.baseFov;
    switch (d.mode) {
      case 'intro':
        fov = this.intro(inp);
        break;
      case 'death':
        this.deathPull(inp);
        break;
      case 'orbit':
        this.orbitBody(inp, CINE.deathPull);
        break;
      case 'killcam':
        if (inp.killer) this.killcam(inp, inp.killer);
        else this.orbitBody(inp, 0);
        break;
      case 'victory':
        this.victory(inp);
        break;
    }
    this.settled = true;
    camera.position.copy(this.pos);
    camera.quaternion.copy(this.quat);
    if (Math.abs(camera.fov - fov) > 1e-4) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    this.eyeDistance = this.pos.distanceTo(inp.fpPos);
    return true;
  }

  /** Orientation looking from `this.pos` at `this.look`. */
  private lookQuat(out: THREE.Quaternion): THREE.Quaternion {
    this.mat.lookAt(this.pos, this.look, UP);
    return out.setFromRotationMatrix(this.mat);
  }

  /** Whether static geometry lies on the straight line from `a` to `b`. */
  private blocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = a.distanceTo(b);
    if (d < 1e-3) return false;
    set3(this.v, a.x, a.y, a.z);
    set3(this.dir, (b.x - a.x) / d, (b.y - a.y) / d, (b.z - a.z) / d);
    return this.cast(this.v, this.dir, d) !== null;
  }

  /** Collided, smoothed camera position for a shot about `pivot` that wants `want`. */
  private placeAbout(pivot: V3, want: V3, dt: number, out: THREE.Vector3): void {
    const wanted = dist3(pivot, want);
    const free = collideCamera(pivot, want, this.cast, this.hit);
    const use = this.collision.update(free, wanted, dt);
    if (wanted < 1e-5) {
      out.set(want.x, want.y, want.z);
      return;
    }
    const k = use / wanted;
    out.set(
      pivot.x + (want.x - pivot.x) * k,
      pivot.y + (want.y - pivot.y) * k,
      pivot.z + (want.z - pivot.z) * k,
    );
  }

  private intro(inp: ShotInputs): number {
    const s = inp.self;
    set3(this.v, inp.fpPos.x, inp.fpPos.y, inp.fpPos.z);
    this.setIntroEnd(this.v, s.yaw, s.pitch);
    const t = this.director.time / CINE.introDuration;
    const u = smootherstep(t);
    this.spline.sample(u, this.want);
    this.lookSpline.sample(u, this.v);
    this.look.set(this.v.x, this.v.y, this.v.z);
    // Near the player, keep off the walls round them (the high keys are above the roofs),
    // phased in over 16 → 10 m so the collision never switches on with a jump.
    set3(this.pivot, inp.fpPos.x, inp.fpPos.y, inp.fpPos.z);
    const near = smoothstep((16 - dist3(this.pivot, this.want)) / 6);
    if (near > 0) {
      this.placeAbout(this.pivot, this.want, inp.dt, this.pos);
      this.pos.set(
        this.want.x + (this.pos.x - this.want.x) * near,
        this.want.y + (this.pos.y - this.want.y) * near,
        this.want.z + (this.pos.z - this.want.z) * near,
      );
    } else this.pos.set(this.want.x, this.want.y, this.want.z);
    this.lookQuat(this.quat);
    // The last stretch turns into the player's own view: the handoff is exact.
    const hand = smootherstep((u - 0.7) / 0.3);
    this.quat.slerp(inp.fpQuat, hand);
    return inp.baseFov + (inp.fpFov - inp.baseFov) * hand;
  }

  /** Behind and above the body, looking down at it (where the pull-out ends, the orbit starts). */
  private bodyShot(inp: ShotInputs, angle: number, out: THREE.Vector3): void {
    const b = inp.self.pos;
    set3(this.pivot, b.x, b.y + 0.9, b.z);
    orbitPoint(this.pivot, 3.1, 1.5, angle, this.want);
    this.placeAbout(this.pivot, this.want, inp.dt, out);
    this.look.set(this.pivot.x, this.pivot.y - 0.2, this.pivot.z);
  }

  private deathPull(inp: ShotInputs): void {
    const w = easeOutCubic(this.director.time / CINE.deathPull);
    this.bodyShot(inp, this.startYaw, this.pos);
    this.pos.lerpVectors(this.startPos, this.pos, w);
    this.lookQuat(this.v3q);
    this.quat.slerpQuaternions(this.startQuat, this.v3q, w);
  }

  /** Slow orbit round the body (own frag, world, unknown killer). */
  private orbitBody(inp: ShotInputs, offset: number): void {
    const t = this.director.time + offset - CINE.deathPull;
    this.bodyShot(inp, this.startYaw + Math.max(0, t) * CINE.orbitSpeed, this.pos);
    this.lookQuat(this.quat);
  }

  /** Over the killer's shoulder, along their aim. */
  private killcam(inp: ShotInputs, k: ShotSubject): void {
    set3(this.pivot, k.pos.x, k.pos.y + k.eye, k.pos.z);
    overShoulder(this.pivot, k.yaw, k.pitch, 1.8, 0.55, 0.28, this.want);
    // Smooth where the shot wants to be, then collide: the eased camera never lags into a
    // wall corner the killer just rounded.
    const f = this.settled ? follow(inp.dt, 0.07) : 1;
    if (!this.settled) this.killWant.set(this.want.x, this.want.y, this.want.z);
    else this.killWant.lerp(this.want, f);
    set3(this.want, this.killWant.x, this.killWant.y, this.killWant.z);
    this.placeAbout(this.pivot, this.want, inp.dt, this.pos);
    forwardOf(k.yaw, k.pitch, this.dir);
    this.look.set(
      this.pivot.x + this.dir.x * 30,
      this.pivot.y + this.dir.y * 30,
      this.pivot.z + this.dir.z * 30,
    );
    this.lookQuat(this.v3q);
    this.quat.slerp(this.v3q, f);
  }

  /** Fly to the winner (or over the map) and turn slowly round them. */
  private victory(inp: ShotInputs): void {
    const t = this.director.time;
    const w = inp.winner;
    if (w) {
      set3(this.pivot, w.pos.x, w.pos.y + w.eye * 0.85, w.pos.z);
      // In front of them (angle = yaw + π), drifting round.
      orbitPoint(
        this.pivot,
        3.4,
        0.35,
        this.startYaw + Math.PI + t * CINE.victoryOrbitSpeed,
        this.want,
      );
      this.look.set(this.pivot.x, this.pivot.y, this.pivot.z);
    } else {
      // Nobody to frame: a slow turn round the map's vantage, looking down at its middle.
      const v = inp.wide;
      set3(this.pivot, v.pivot.x, v.pivot.y, v.pivot.z);
      orbitPoint(this.pivot, 45, 10, t * 0.05, this.want);
      this.look.set(v.look.x, v.look.y, v.look.z);
    }
    // Once on the shot, following a winner who moves: where the shot wants to be is eased,
    // and the camera is the collision of that from the winner — so every frame it sits on a
    // clear line from them, never on a blend of two safe points that cuts through a corner.
    if (this.orbiting) this.vicWant.lerp(this.want, follow(inp.dt, 0.12));
    else this.vicWant.set(this.want.x, this.want.y, this.want.z);
    set3(this.want, this.vicWant.x, this.vicWant.y, this.vicWant.z);
    this.placeAbout(this.pivot, this.want, inp.dt, this.orbitPos);
    const fly = this.flyCut ? 1 : smootherstep(t / CINE.victoryFly);
    if (fly < 1) {
      // The fly-in is a straight line to a shot that moves with the winner: every frame, the
      // step it is about to take and the rest of the way must be clear, or it becomes a cut.
      this.flyTo.lerpVectors(this.startPos, this.orbitPos, fly);
      const from = this.settled && this.flying ? this.pos : this.startPos;
      if (this.blocked(from, this.flyTo) || this.blocked(this.flyTo, this.orbitPos)) {
        this.flyCut = true;
        this.snapNext = true;
      } else {
        this.flying = true;
        this.pos.copy(this.flyTo);
        this.lookQuat(this.v3q);
        this.quat.slerpQuaternions(this.startQuat, this.v3q, fly);
        return;
      }
    }
    if (this.snapNext) {
      this.snapNext = false; // the cut lands on the shot
      this.orbiting = true;
      this.pos.copy(this.orbitPos);
      this.lookQuat(this.quat);
      return;
    }
    this.orbiting = true;
    this.pos.copy(this.orbitPos);
    this.lookQuat(this.v3q);
    this.quat.slerp(this.v3q, follow(inp.dt, 0.12));
  }
}
