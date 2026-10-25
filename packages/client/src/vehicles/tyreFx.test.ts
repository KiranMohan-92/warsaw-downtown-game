import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  boxMinMax,
  getMap,
  MAP_IDS,
  MAP_SIZES,
  resolveMap,
  createVehicleMotion,
  initPhysics,
  PhysicsWorld,
  stepVehicle,
  WHEELS,
  VEHICLE,
  type DriveControls,
  type SurfaceKind,
  type VehicleMotion,
  type WheelId,
  type WorldHit,
} from '@wd/shared';
import { ImpactDebris } from '../render/debris.ts';
import { FLAT_LIFT, OVER_FLATS, flatDrawLayer } from '../render/mapMesh.ts';
import { TyreFx } from './tyreFx.ts';
import {
  DUST_SLIP,
  SKID_SLIP,
  inWheelReach,
  slipAmount,
  wheelSlip,
  type SlipPose,
} from './tyreSlip.ts';
import { VehiclesView } from './vehiclesView.ts';

const DT = 1 / 60;

beforeAll(async () => {
  await initPhysics();
});

const flatWorld = (): PhysicsWorld =>
  new PhysicsWorld({
    name: 'tyres',
    bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 },
    boxes: [boxMinMax({ x: -200, y: -1, z: -200 }, { x: 200, y: 0, z: 200 }, 'paving')],
    spawns: [],
    dummies: [],
  });

const ground = (x: number, z: number, surface: SurfaceKind = 'stone'): WorldHit => ({
  distance: 0.5,
  point: { x, y: 0, z },
  normal: { x: 0, y: 1, z: 0 },
  visible: true,
  surface,
});

/** Contacts under each wheel of a pose on flat ground. */
function contactsOf(m: VehicleMotion, surface: SurfaceKind = 'stone'): WorldHit[] {
  const c = Math.cos(m.yaw);
  const s = Math.sin(m.yaw);
  return WHEELS.map((w) => {
    const lx = w.endsWith('l') ? 0.875 : -0.875;
    const lz = w.startsWith('f') ? 1.55 : -1.55;
    return ground(m.pos.x + lx * c + lz * s, m.pos.z - lx * s + lz * c, surface);
  });
}

type Phase = { frames: number; controls: DriveControls };

/** Drive the real shared sim; per frame: the motion and each wheel's slip (smoothed accel). */
function drive(phases: Phase[]): { motion: VehicleMotion; slip: Record<WheelId, number> }[] {
  const world = flatWorld();
  const m = createVehicleMotion({ x: 0, y: 0, z: -150 }, 0);
  const prev: SlipPose = structuredClone(m);
  let accel = 0;
  const out: { motion: VehicleMotion; slip: Record<WheelId, number> }[] = [];
  for (const phase of phases) {
    for (let f = 0; f < phase.frames; f++) {
      stepVehicle(m, phase.controls, DT, world);
      const s = slipAmount(m, prev, DT);
      accel += (s.accel - accel) * Math.min(1, DT * 10);
      Object.assign(prev, structuredClone(m));
      const slip = Object.fromEntries(WHEELS.map((w) => [w, wheelSlip(w, s, accel)])) as Record<
        WheelId,
        number
      >;
      out.push({ motion: structuredClone(m), slip });
    }
  }
  return out;
}

const max = (frames: { slip: Record<WheelId, number> }[], w: WheelId): number =>
  Math.max(...frames.map((f) => f.slip[w]));

const GO: DriveControls = { throttle: 1, steer: 0, handbrake: false };

describe('tyre slip on the real truck sim', () => {
  it('rolls clean at speed, flat out and at full lock', () => {
    const frames = drive([
      { frames: 360, controls: GO },
      { frames: 240, controls: { throttle: 1, steer: 1, handbrake: false } },
      { frames: 120, controls: { throttle: 0.4, steer: -1, handbrake: false } },
    ]);
    const cruising = frames.slice(300);
    for (const w of WHEELS) expect(max(cruising, w)).toBeLessThan(DUST_SLIP);
    // ...but the launch from a standstill spun the wheels.
    for (const w of WHEELS) expect(max(frames.slice(0, 40), w)).toBeGreaterThan(DUST_SLIP);
  });

  it('drifts on the handbrake: the rear slides past the skid threshold, more than the front', () => {
    const frames = drive([
      { frames: 150, controls: GO },
      { frames: 90, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]);
    const drift = frames.slice(150);
    for (const w of ['rl', 'rr'] as const) expect(max(drift, w)).toBeGreaterThanOrEqual(SKID_SLIP);
    expect(max(drift, 'rl')).toBeGreaterThan(max(drift, 'fl'));
  });

  it('locks all four under hard braking', () => {
    const frames = drive([
      { frames: 300, controls: GO },
      { frames: 30, controls: { throttle: -1, steer: 0, handbrake: false } },
    ]);
    for (const w of WHEELS) expect(max(frames.slice(300), w)).toBeGreaterThanOrEqual(SKID_SLIP);
  });
});

describe('tyre dust and skid marks', () => {
  function play(fx: TyreFx, frames: { motion: VehicleMotion }[], surface?: SurfaceKind): void {
    for (const f of frames) {
      fx.truck(1, f.motion, true, contactsOf(f.motion, surface), DT);
      fx.update(DT);
    }
  }

  it('kicks up dust and lays skid marks in a drift, none while cruising', () => {
    const cruise = drive([{ frames: 420, controls: GO }]).slice(300);
    const quiet = new TyreFx(() => 0.5);
    play(quiet, cruise);
    expect(quiet.stats()).toEqual({ dust: 0, skids: 0 });

    const fx = new TyreFx(() => 0.5);
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 90, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    play(fx, drift);
    expect(fx.stats().dust).toBeGreaterThan(10);
    expect(fx.stats().skids).toBeGreaterThan(10);
    const mesh = fx.group.getObjectByName('fx:skid-marks') as THREE.Mesh;
    expect(mesh.geometry.drawRange.count).toBe(fx.stats().skids * 6);
    // Ribbons lie on the ground (lifted a hair), a tyre or so wide.
    const pos = fx.ring.positions;
    for (let i = 0; i < fx.stats().skids * 4; i++) {
      expect(pos[i * 3 + 1]).toBeGreaterThan(0);
      expect(pos[i * 3 + 1]).toBeLessThan(0.05);
    }
    for (let s = 0; s < fx.stats().skids; s++) {
      const w = Math.hypot(
        pos[s * 12 + 6]! - pos[s * 12 + 9]!,
        pos[s * 12 + 8]! - pos[s * 12 + 11]!,
      );
      expect(w).toBeGreaterThan(0.25);
      expect(w).toBeLessThan(0.45);
    }
  });

  it('lets the dust grow, drift downwind and fade within ~2.5 s', () => {
    const fx = new TyreFx(() => 0.5);
    fx.setWind(1, 0, 1);
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 50, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    play(fx, drift);
    expect(fx.stats().dust).toBeGreaterThan(0);
    const sprites = fx.group.getObjectByName('fx:tyre-dust') as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.MeshBasicMaterial
    >;
    const size = sprites.geometry.getAttribute('aSize');
    const center = sprites.geometry.getAttribute('aCenter');
    const firstSize = size.getX(0);
    const firstX = center.getX(0);
    for (let i = 0; i < 30; i++) fx.update(DT);
    expect(size.getX(0)).toBeGreaterThan(firstSize * 1.3);
    expect(center.getX(0)).toBeGreaterThan(firstX); // the wind blows +x
    for (let i = 0; i < 150; i++) fx.update(DT);
    expect(fx.stats().dust).toBe(0);
    // Skid marks outlive the dust.
    expect(fx.stats().skids).toBeGreaterThan(0);
  });

  it('colours dust by the ground under the wheel', () => {
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 30, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    const colour = (surface: SurfaceKind): number[] => {
      const fx = new TyreFx(() => 0.5);
      play(fx, drift, surface);
      const c = (fx.group.getObjectByName('fx:tyre-dust') as THREE.Mesh).geometry.getAttribute(
        'color',
      );
      return [c.getX(0), c.getY(0), c.getZ(0)];
    };
    const paving = colour('stone');
    const soil = colour('soft');
    expect(soil[0]! / soil[2]!).toBeGreaterThan(paving[0]! / paving[2]!);
  });

  it('restarts cleanly after a cut or a truck leaving the view (no streak across the map)', () => {
    const fx = new TyreFx(() => 0.5);
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 40, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    play(fx, drift.slice(0, 20));
    const before = fx.stats().skids;
    // Not reported for a frame (hidden / replay), then back 40 m away.
    fx.update(DT);
    const moved = drift.slice(20).map((f) => {
      const m = structuredClone(f.motion);
      m.pos.x += 40;
      return { motion: m };
    });
    play(fx, moved.slice(0, 1));
    expect(fx.stats().skids).toBe(before);
    play(fx, moved.slice(1));
    const pos = fx.ring.positions;
    for (let s = before; s < fx.stats().skids; s++) {
      const len = Math.hypot(pos[s * 12 + 6]! - pos[s * 12]!, pos[s * 12 + 8]! - pos[s * 12 + 2]!);
      expect(len).toBeLessThan(3);
    }
  });

  it('wrecks and airborne wheels lay nothing', () => {
    const fx = new TyreFx(() => 0.5);
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 60, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    for (const f of drift) {
      fx.truck(1, f.motion, false, contactsOf(f.motion), DT);
      fx.truck(2, f.motion, true, [null, null, null, null], DT);
      fx.update(DT);
    }
    expect(fx.stats()).toEqual({ dust: 0, skids: 0 });
  });

  it('reuses its buffers and pools: nothing grows over a long drift', () => {
    const fx = new TyreFx();
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 600, controls: { throttle: 0.7, steer: 1, handbrake: true } },
    ]).slice(150);
    const mesh = fx.group.getObjectByName('fx:skid-marks') as THREE.Mesh;
    const dustMesh = fx.group.getObjectByName('fx:tyre-dust') as THREE.Mesh;
    const arrays = [
      ...Object.values(mesh.geometry.attributes).map((a) => a.array),
      ...Object.values(dustMesh.geometry.attributes).map((a) => a.array),
    ];
    const materials = [mesh.material, dustMesh.material];
    play(fx, drift);
    expect([
      ...Object.values(mesh.geometry.attributes).map((a) => a.array),
      ...Object.values(dustMesh.geometry.attributes).map((a) => a.array),
    ]).toEqual(arrays);
    expect([mesh.material, dustMesh.material]).toEqual(materials);
    expect(fx.group.children).toHaveLength(2);
  });

  it('shares the impact dust program and warms its ribbon batch with a real draw', () => {
    const fx = new TyreFx();
    const dust = fx.group.getObjectByName('fx:tyre-dust') as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.MeshBasicMaterial
    >;
    const impacts = new ImpactDebris();
    const impactDust = impacts.group.getObjectByName('fx:dust') as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.MeshBasicMaterial
    >;
    const a = dust.material;
    const b = impactDust.material;
    expect(a.customProgramCacheKey()).toBe(b.customProgramCacheKey());
    expect(a.map).toBe(b.map);
    for (const k of ['transparent', 'vertexColors', 'fog', 'blending', 'depthWrite'] as const) {
      expect(a[k]).toBe(b[k]);
    }
    const skids = fx.group.getObjectByName('fx:skid-marks') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    >;
    expect(skids.material.polygonOffset).toBe(true);
    expect(skids.material.depthWrite).toBe(false);
    expect(skids.geometry.drawRange.count).toBe(0);
    expect(dust.geometry.instanceCount).toBe(0);
    const restore = fx.beginWarmUp();
    expect(skids.geometry.drawRange.count).toBeGreaterThan(0);
    expect(dust.geometry.instanceCount).toBe(1);
    restore();
    expect(skids.geometry.drawRange.count).toBe(0);
    expect(dust.geometry.instanceCount).toBe(0);
  });

  it('fades skid marks in the vertex shader by age', () => {
    const fx = new TyreFx();
    const skids = fx.group.getObjectByName('fx:skid-marks') as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    >;
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.basic.vertexShader,
      fragmentShader: THREE.ShaderLib.basic.fragmentShader,
    };
    skids.material.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader).toContain('attribute float aBorn;');
    expect(shader.vertexShader).toContain('skidTime - aBorn');
    fx.update(0.05);
    fx.update(0.05);
    expect(shader.uniforms.skidTime!.value).toBeCloseTo(0.1);
  });
});

describe('vehicles view', () => {
  it('owns the tyre effects and warms them up', () => {
    const world = flatWorld();
    const view = new VehiclesView(world, [{ id: 1, x: 0, y: 0, z: 0, yaw: 0 }]);
    expect(view.group.getObjectByName('fx:tyres')).toBe(view.tyres.group);
    const restore = view.beginWarmUp();
    const skids = view.group.getObjectByName('fx:skid-marks') as THREE.Mesh;
    expect(skids.geometry.drawRange.count).toBeGreaterThan(0);
    restore();
    expect(skids.geometry.drawRange.count).toBe(0);
    // A replayed frame (fx off) places the truck but lays nothing.
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 60, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    for (const f of drift) {
      view.update(DT, [{ id: 1, motion: f.motion, condition: 'active', health: 1 }], false);
    }
    expect(view.tyres.stats()).toEqual({ dust: 0, skids: 0 });
    for (const f of drift) {
      view.update(DT, [{ id: 1, motion: f.motion, condition: 'active', health: 1 }]);
    }
    expect(view.tyres.stats().skids).toBeGreaterThan(0);
  });
});

describe('skid marks over the map ground', () => {
  it('clear every ground flat of every map: lift and polygon offset beyond the deepest layer', () => {
    // The cause of invisible marks: paving is drawn as flats lifted up to ~2 cm with polygon
    // offsets up to (−12, −26); a mark at 1.2 cm with (−2, −4) was under them.
    let deepest = 0;
    for (const id of MAP_IDS) {
      for (const size of MAP_SIZES) {
        for (const f of resolveMap(getMap(id), size).flats ?? []) {
          deepest = Math.max(deepest, flatDrawLayer(f));
        }
      }
    }
    expect(deepest).toBeLessThanOrEqual(OVER_FLATS.maxLayer);
    const L = OVER_FLATS.maxLayer;
    expect(OVER_FLATS.lift).toBeGreaterThan(FLAT_LIFT.base + L * FLAT_LIFT.perLayer + 0.005);
    expect(OVER_FLATS.factor).toBeLessThan(-1 - L);
    expect(OVER_FLATS.units).toBeLessThan(-4 - 2 * L);

    const fx = new TyreFx(() => 0.5);
    const mat = (fx.group.getObjectByName('fx:skid-marks') as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    expect(mat.polygonOffset).toBe(true);
    expect(mat.polygonOffsetFactor).toBe(OVER_FLATS.factor);
    expect(mat.polygonOffsetUnits).toBe(OVER_FLATS.units);
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 60, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    for (const f of drift) {
      fx.truck(1, f.motion, true, contactsOf(f.motion), DT);
      fx.update(DT);
    }
    expect(fx.stats().skids).toBeGreaterThan(0);
    for (let i = 0; i < fx.stats().skids * 4; i++) {
      expect(fx.ring.positions[i * 3 + 1]).toBeCloseTo(OVER_FLATS.lift, 5);
      // Dark rubber, 0.55–0.7 opaque when laid.
      expect(fx.ring.colors[i * 4]).toBeLessThan(0.03);
      expect(fx.ring.colors[i * 4 + 3]).toBeGreaterThanOrEqual(0.55);
      expect(fx.ring.colors[i * 4 + 3]).toBeLessThanOrEqual(0.7 + 1e-6);
    }
  });

  it('lays each ribbon edge on the lifted ground plane on a slope', () => {
    // A 14° ramp rising along +z under every wheel.
    const tilt = (14 * Math.PI) / 180;
    const normal = { x: 0, y: Math.cos(tilt), z: -Math.sin(tilt) };
    const fx = new TyreFx(() => 0.5);
    const drift = drive([
      { frames: 150, controls: GO },
      { frames: 60, controls: { throttle: 0.6, steer: 1, handbrake: true } },
    ]).slice(150);
    for (const f of drift) {
      const contacts = contactsOf(f.motion).map((c) => ({
        ...c,
        point: { ...c.point, y: c.point.z * Math.tan(tilt) },
        normal,
      }));
      fx.truck(1, f.motion, true, contacts, DT);
      fx.update(DT);
    }
    expect(fx.stats().skids).toBeGreaterThan(5);
    const p = fx.ring.positions;
    const above = OVER_FLATS.lift / Math.cos(tilt); // the lift along the normal, as height
    for (let i = 0; i < fx.stats().skids * 4; i++) {
      const y = p[i * 3 + 1]!;
      const z = p[i * 3 + 2]!;
      expect(Math.abs(y - (z * Math.tan(tilt) + above))).toBeLessThan(2e-3);
    }
  });

  it('never shows dust through smoke (concealment), like impact debris', () => {
    const run = (smoke: boolean): number[] => {
      const fx = new TyreFx(() => 0.5);
      const drift = drive([
        { frames: 150, controls: GO },
        { frames: 50, controls: { throttle: 0.6, steer: 1, handbrake: true } },
      ]).slice(150);
      const at = drift[drift.length - 1]!.motion.pos;
      const eye = { x: at.x + 14, y: 1.7, z: at.z };
      fx.setSmoke(eye, smoke ? [{ id: 1, pos: { x: at.x + 7, y: 0, z: at.z }, age: 3 }] : []);
      for (const f of drift) {
        fx.truck(1, f.motion, true, contactsOf(f.motion), DT);
        fx.update(DT);
      }
      const c = (
        fx.group.getObjectByName('fx:tyre-dust') as THREE.Mesh<THREE.InstancedBufferGeometry>
      ).geometry;
      const color = c.getAttribute('color');
      return Array.from({ length: c.instanceCount }, (_, i) => color.getW(i));
    };
    const clear = run(false);
    expect(Math.max(...clear)).toBeGreaterThan(0.2);
    const hidden = run(true);
    expect(hidden.length).toBe(clear.length);
    for (const a of hidden) expect(a).toBeLessThan(0.02);
  });
});

describe('presentation contacts under the wheels', () => {
  /** A truck pose at `(0, y, 0)` heading +z, sliding hard (a drift), grounded. */
  const sliding = (y: number): VehicleMotion => {
    const m = createVehicleMotion({ x: 0, y, z: 0 }, 0);
    m.vel = { x: -5, y: 0, z: 8 };
    m.yawRate = 1.4;
    return m;
  };
  const capture = (view: VehiclesView, motion: VehicleMotion): (WorldHit | null)[][] => {
    const seen: (WorldHit | null)[][] = [];
    const original = view.tyres.truck.bind(view.tyres);
    view.tyres.truck = (id, m, active, contacts, dt) => {
      seen.push([...contacts]);
      original(id, m, active, contacts, dt);
    };
    for (let f = 0; f < 30; f++) {
      motion.pos.x += motion.vel.x * DT;
      motion.pos.z += motion.vel.z * DT;
      view.update(DT, [{ id: 1, motion, condition: 'active', health: 1 }]);
    }
    return seen;
  };

  it('ignores ground far below a wheel hanging over a drop (no dust or skids down there)', () => {
    // A 1 m ledge: the platform ends at z = -0.5; the rear axle (z -1.55) overhangs the drop.
    const world = new PhysicsWorld({
      name: 'ledge',
      bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
      boxes: [
        boxMinMax({ x: -60, y: -1, z: -60 }, { x: 60, y: 0, z: 60 }, 'paving'),
        boxMinMax({ x: -60, y: 0, z: -0.5 }, { x: 60, y: 1, z: 60 }, 'paving'),
      ],
      spawns: [],
      dummies: [],
    });
    const view = new VehiclesView(world);
    const motion = sliding(1);
    motion.vel = { x: -5, y: 0, z: 0.01 }; // slide sideways along the edge
    const seen = capture(view, motion);
    for (const contacts of seen) {
      WHEELS.forEach((w, i) => {
        if (w.startsWith('r')) expect(contacts[i]).toBeNull();
        else expect(contacts[i]?.point.y).toBeCloseTo(1, 3);
      });
    }
    expect(view.tyres.stats().skids).toBeGreaterThan(0); // the front still marks
    const p = view.tyres.ring.positions;
    for (let i = 0; i < view.tyres.stats().skids * 4; i++) {
      expect(p[i * 3 + 1]).toBeGreaterThan(0.9); // nothing laid on the lower ground
    }
    expect(inWheelReach(0)).toBe(true);
    expect(inWheelReach(-VEHICLE.droop)).toBe(true);
    expect(inWheelReach(-1)).toBe(false);
    expect(inWheelReach(VEHICLE.maxStep)).toBe(true);
    expect(inWheelReach(0.8)).toBe(false);
  });

  it('puts the tyre on the rendered treads, not an invisible stair ramp', () => {
    // A collision-only smoothing ramp 16 cm over the visible ground (`visible: false`).
    const ramp = boxMinMax({ x: -60, y: 0, z: -60 }, { x: 60, y: 0.16, z: 60 }, 'concrete');
    ramp.visible = false;
    const world = new PhysicsWorld({
      name: 'stairs',
      bounds: { minX: -60, maxX: 60, minZ: -60, maxZ: 60 },
      boxes: [boxMinMax({ x: -60, y: -1, z: -60 }, { x: 60, y: 0, z: 60 }, 'paving'), ramp],
      spawns: [],
      dummies: [],
    });
    const view = new VehiclesView(world);
    const seen = capture(view, sliding(0.1));
    for (const contacts of seen) {
      for (const c of contacts) expect(c?.point.y).toBeCloseTo(0, 3);
    }
    const p = view.tyres.ring.positions;
    expect(view.tyres.stats().skids).toBeGreaterThan(0);
    for (let i = 0; i < view.tyres.stats().skids * 4; i++) {
      expect(p[i * 3 + 1]).toBeLessThan(OVER_FLATS.lift + 0.01);
    }
  });
});
