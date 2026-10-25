import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CameraDirector, CINE, type KillInfo } from './cameraDirector.ts';
import { blankSubject, CinematicCamera, MARKET_INTRO, type ShotInputs } from './cinematicCamera.ts';
import { forwardOf, type RayCast } from './cinematicMath.ts';

const kill: KillInfo = {
  killer: 'b',
  killerName: 'B',
  weapon: 'AR-7 rifle',
  distance: 12,
  headshot: false,
  killMs: 0,
};

function setup(cast: RayCast = () => null) {
  const director = new CameraDirector();
  const cine = new CinematicCamera(director);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 600);
  // The first-person view: standing at (100, 0, 10), facing yaw 0.4, level.
  const yaw = 0.4;
  const fpQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  const self = blankSubject();
  self.pos = { x: 100, y: 0, z: 10 };
  self.yaw = yaw;
  const inp: ShotInputs = {
    dt: 1 / 60,
    fpPos: new THREE.Vector3(100, 1.62, 10),
    fpQuat,
    fpFov: 62,
    baseFov: 60,
    self,
    killer: null,
    winner: null,
    wide: { pivot: { x: 100, y: 20, z: 0 }, look: { x: 100, y: 0, z: 0 } },
    cast,
  };
  return { director, cine, camera, inp, yaw };
}

/** Run the director and the composer for `seconds` of 60 Hz frames. */
function run(
  s: ReturnType<typeof setup>,
  seconds: number,
  each?: (c: THREE.PerspectiveCamera) => void,
): void {
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    s.director.update(1 / 60);
    s.cine.update(s.inp, s.camera);
    each?.(s.camera);
  }
}

describe('CinematicCamera', () => {
  it('first person untouched while nothing plays', () => {
    const s = setup();
    s.camera.position.set(1, 2, 3);
    expect(s.cine.update(s.inp, s.camera)).toBe(false);
    expect(s.camera.position.toArray()).toEqual([1, 2, 3]);
  });

  it('intro: starts over the Market keys and hands off exactly at the eye, without jumps', () => {
    const s = setup();
    s.director.startIntro();
    s.cine.planIntro(MARKET_INTRO, { x: 100, y: 1.62, z: 10 }, s.yaw, 0, s.inp.cast);
    s.cine.update(s.inp, s.camera);
    const k0 = MARKET_INTRO[0]!.pos;
    expect(s.camera.position.distanceTo(new THREE.Vector3(k0.x, k0.y, k0.z))).toBeLessThan(0.5);
    const prev = s.camera.position.clone();
    let maxStep = 0;
    run(s, CINE.introDuration - 2 / 60, (c) => {
      maxStep = Math.max(maxStep, c.position.distanceTo(prev));
      prev.copy(c.position);
    });
    expect(s.director.mode).toBe('intro');
    // Last frame before the handoff: on the eye, looking where the player looks.
    expect(s.camera.position.distanceTo(s.inp.fpPos)).toBeLessThan(0.05);
    expect(s.camera.quaternion.angleTo(s.inp.fpQuat)).toBeLessThan(0.01);
    expect(s.camera.fov).toBeCloseTo(s.inp.fpFov, 1);
    // Fast in the middle (a fly-over), but never a teleport between frames.
    expect(maxStep).toBeLessThan(3);
    run(s, 0.1);
    expect(s.director.mode).toBe('play');
  });

  it('death cam: pulls out of the head to behind and above the body, looking at it', () => {
    const s = setup();
    s.director.died({ ...kill, killer: null });
    s.cine.update(s.inp, s.camera);
    // The first frame is (nearly) the first-person view: no cut.
    expect(s.camera.position.distanceTo(s.inp.fpPos)).toBeLessThan(0.4);
    run(s, CINE.deathPull - 1 / 60);
    const body = new THREE.Vector3(100, 0.9, 10);
    const off = s.camera.position.clone().sub(body);
    expect(off.y).toBeGreaterThan(1);
    const f = forwardOf(s.yaw, 0, { x: 0, y: 0, z: 0 });
    expect(off.x * f.x + off.z * f.z).toBeLessThan(-2); // behind the body
    const view = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camera.quaternion);
    expect(view.dot(body.clone().sub(s.camera.position).normalize())).toBeGreaterThan(0.98);
    // Then the orbit (own frag) carries on from there without a jump.
    const before = s.camera.position.clone();
    run(s, 2 / 60);
    expect(s.director.mode).toBe('orbit');
    expect(s.camera.position.distanceTo(before)).toBeLessThan(0.2);
  });

  it("kill cam: over the killer's shoulder, along their aim", () => {
    const s = setup();
    const k = blankSubject();
    k.pos = { x: 80, y: 0, z: 10 };
    k.yaw = -Math.PI / 2; // facing +X, toward the victim
    s.inp.killer = k;
    s.director.died(kill);
    run(s, CINE.deathPull + 0.2);
    expect(s.director.mode).toBe('killcam');
    const eye = new THREE.Vector3(80, 1.62, 10);
    expect(s.camera.position.x).toBeLessThan(eye.x - 1); // behind (−X)
    expect(s.camera.position.z).toBeGreaterThan(eye.z + 0.3); // right shoulder (+Z)
    const view = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camera.quaternion);
    expect(view.x).toBeGreaterThan(0.95);
  });

  it('kill cam: a wall behind the killer keeps the camera on their side of it', () => {
    // Wall at x = 79 (just behind the killer at x = 80).
    const wall: RayCast = (o, d, max) => {
      if (d.x >= 0) return null;
      const t = (79 - o.x) / d.x;
      return t >= 0 && t <= max ? t : null;
    };
    const s = setup(wall);
    const k = blankSubject();
    k.pos = { x: 80, y: 0, z: 10 };
    k.yaw = -Math.PI / 2;
    s.inp.killer = k;
    s.director.died(kill);
    run(s, CINE.deathPull + 0.5, (c) => expect(c.position.x).toBeGreaterThan(79));
  });

  it('victory: flies from first person to the winner and turns slowly round them', () => {
    const s = setup();
    const w = blankSubject();
    w.pos = { x: 120, y: 0, z: -20 };
    w.yaw = 1;
    s.inp.winner = w;
    s.director.matchEnded();
    s.cine.update(s.inp, s.camera);
    expect(s.camera.position.distanceTo(s.inp.fpPos)).toBeLessThan(0.5);
    run(s, CINE.victoryFly + 0.5);
    const chest = new THREE.Vector3(120, 1.62 * 0.85, -20);
    const d = s.camera.position.distanceTo(chest);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(3.8);
    const view = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camera.quaternion);
    expect(view.dot(chest.clone().sub(s.camera.position).normalize())).toBeGreaterThan(0.95);
    // In front of them (they face yaw 1).
    const f = forwardOf(1, 0, { x: 0, y: 0, z: 0 });
    const off = s.camera.position.clone().sub(chest);
    expect(off.x * f.x + off.z * f.z).toBeGreaterThan(1.5);
  });

  it('victory: a wall between the player and the winner makes the fly-in a cut', () => {
    // Wall x = 110 between the eye (x 100) and the winner (x 120); nothing else.
    const wall: RayCast = (o, d, max) => {
      if (Math.abs(d.x) < 1e-9) return null;
      const t = (110 - o.x) / d.x;
      return t >= 0 && t <= max ? t : null;
    };
    const s = setup(wall);
    const w = blankSubject();
    w.pos = { x: 120, y: 0, z: -20 };
    w.yaw = -Math.PI / 2; // facing +X: the shot stands in front, beyond the wall
    s.inp.winner = w;
    s.director.matchEnded();
    run(s, 1 / 60, (c) => expect(c.position.x).toBeGreaterThan(110));
  });

  it('victory: a winner who moves behind a wall mid-flight turns the fly-in into a cut', () => {
    // Wall x = 110. The winner starts on our side (x 105), then is beyond it (x 125).
    const wall: RayCast = (o, d, max) => {
      if (Math.abs(d.x) < 1e-9) return null;
      const t = (110 - o.x) / d.x;
      return t > 1e-6 && t <= max ? t : null;
    };
    const s = setup(wall);
    const w = blankSubject();
    w.pos = { x: 105, y: 0, z: -20 };
    w.yaw = Math.PI / 2; // facing −X: the shot stands in front of them, on our side
    s.inp.winner = w;
    s.director.matchEnded();
    run(s, 0.5);
    expect(s.camera.position.x).toBeLessThan(110); // mid-flight, this side of the wall
    w.pos = { x: 125, y: 0, z: -20 };
    w.yaw = -Math.PI / 2; // now facing +X: the shot is beyond the wall
    const chest = new THREE.Vector3(125, 1.62 * 0.85, -20);
    run(s, 2, (c) => {
      // Never inside or sliding through the wall: either still on our side, or already on
      // the shot round the winner (the cut), nothing in between.
      const onShot = c.position.distanceTo(chest) < 4;
      expect(c.position.x < 110 || onShot).toBe(true);
    });
    expect(s.camera.position.distanceTo(chest)).toBeLessThan(4);
  });

  it('victory: a winner walking round a wall corner never drags the camera through it', () => {
    // A solid block (x 110–114, z −30–−10, tall); ray vs box, with the hit normal.
    const box = { x0: 110, x1: 114, z0: -30, z1: -10 };
    const block: RayCast = (o, d, max, n) => {
      let tmin = 0;
      let tmax = max;
      let axis = -1;
      const slab = (p: number, v: number, lo: number, hi: number, a: number): boolean => {
        if (Math.abs(v) < 1e-12) return p > lo && p < hi;
        let t0 = (lo - p) / v;
        let t1 = (hi - p) / v;
        if (t0 > t1) [t0, t1] = [t1, t0];
        if (t0 > tmin) {
          tmin = t0;
          axis = a;
        }
        tmax = Math.min(tmax, t1);
        return tmin <= tmax;
      };
      if (!slab(o.x, d.x, box.x0, box.x1, 0) || !slab(o.z, d.z, box.z0, box.z1, 2)) return null;
      if (axis < 0) return 0; // starts inside
      if (n)
        Object.assign(n, {
          x: axis === 0 ? -Math.sign(d.x) : 0,
          y: 0,
          z: axis === 2 ? -Math.sign(d.z) : 0,
        });
      return tmin;
    };
    const inside = (p: { x: number; z: number }, margin: number): boolean =>
      p.x > box.x0 - margin &&
      p.x < box.x1 + margin &&
      p.z > box.z0 - margin &&
      p.z < box.z1 + margin;
    const s = setup(block);
    const w = blankSubject();
    // The winner walks a loop 2 m outside the block, round all four corners, at 5 m/s.
    const loop = [
      [108, -32],
      [116, -32],
      [116, -8],
      [108, -8],
    ] as const;
    const place = (dist: number): void => {
      let left = dist % (2 * (8 + 24));
      for (let i = 0; i < 4; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % 4]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (left <= len) {
          w.pos = {
            x: a[0] + ((b[0] - a[0]) * left) / len,
            y: 0,
            z: a[1] + ((b[1] - a[1]) * left) / len,
          };
          w.yaw = Math.atan2(-(b[0] - a[0]), -(b[1] - a[1]));
          return;
        }
        left -= len;
      }
    };
    place(0);
    s.inp.winner = w;
    s.inp.fpPos.set(104, 1.62, -36);
    s.director.matchEnded();
    let walked = 0;
    let orbitFrames = 0;
    const chest = { x: 0, y: 0, z: 0 };
    const dir = { x: 0, y: 0, z: 0 };
    run(s, CINE.victoryFly + 14, (c) => {
      // (the winner moves after the composer ran: the next frame sees the new position)
      const onShot = s.director.time > CINE.victoryFly + 0.2;
      if (onShot) {
        orbitFrames++;
        // Never inside the block (nor within most of the collision margin of it)…
        expect(inside(c.position, 0.15)).toBe(false);
        // …and always with a clear line to the winner it frames.
        Object.assign(chest, { x: w.pos.x, y: w.pos.y + w.eye * 0.85, z: w.pos.z });
        const d = Math.hypot(
          chest.x - c.position.x,
          chest.y - c.position.y,
          chest.z - c.position.z,
        );
        Object.assign(dir, {
          x: (chest.x - c.position.x) / d,
          y: (chest.y - c.position.y) / d,
          z: (chest.z - c.position.z) / d,
        });
        expect(block(c.position, dir, d)).toBeNull();
      }
      walked += 5 / 60;
      place(walked);
    });
    expect(orbitFrames).toBeGreaterThan(600);
  });

  it('victory without a winner: a wide shot from the vantage, above the ground', () => {
    // The ground (y = 0) as the physics ray sees it.
    const ground: RayCast = (o, d, max) => {
      if (d.y >= 0) return o.y <= 0 ? 0 : null;
      const t = o.y / -d.y;
      return t >= 0 && t <= max ? t : null;
    };
    const s = setup(ground);
    s.inp.fpPos.set(100, 1.62, 10);
    s.director.matchEnded();
    run(s, CINE.victoryFly + 0.5, (c) => expect(c.position.y).toBeGreaterThan(1));
    // Up at the vantage (never collapsed onto a pivot in the ground), looking down at the map.
    expect(s.camera.position.y).toBeGreaterThan(25);
    const d = Math.hypot(s.camera.position.x - 100, s.camera.position.z);
    expect(d).toBeGreaterThan(40);
    const view = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camera.quaternion);
    expect(view.y).toBeLessThan(-0.3);
  });
});
