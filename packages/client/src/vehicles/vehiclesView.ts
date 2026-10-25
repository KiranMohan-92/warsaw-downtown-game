/**
 * Draws the match's trucks: pose (the driver's own truck from its prediction, everyone else's
 * interpolated on the remote-player timeline), wheel spin and steering, a suspension visual
 * (each wheel finds the ground under it: presentation only, the sim has its own), the wreck look,
 * a burning bonnet when the truck is nearly done, and tyre dust + skid marks where the wheels slip
 * (`tyreFx.ts`). Never feeds back into the sim.
 */
import * as THREE from 'three';
import {
  TRUCK,
  WHEEL_POS,
  WHEELS,
  type VehicleCondition,
  type VehicleMotion,
  type WorldHit,
  type WorldRaycaster,
} from '@wd/shared';
import { gltfLoader } from '../render/gltfLoader.ts';
import {
  buildTruckPlaceholder,
  hasTruckLayout,
  truckMaterials,
  WHEEL_NODE,
  type TruckMaterials,
} from './truckModel.ts';
import { TyreFx } from './tyreFx.ts';
import { inWheelReach } from './tyreSlip.ts';

export interface DrawnVehicle {
  id: number;
  motion: VehicleMotion;
  condition: VehicleCondition;
  /** Health share 0–1. */
  health: number;
}

interface Instance {
  /** The pose (position, heading, tilt); holds the intact model and the wreck variant. */
  root: THREE.Group;
  intact: THREE.Object3D;
  /** The art lane's destroyed variant (same node layout), if it shipped; else a burnt swap. */
  alt: THREE.Object3D | null;
  wheels: THREE.Object3D[];
  /** Rest height of each wheel centre (local y). */
  rest: number[];
  /** Suspension offset per wheel (m, smoothed). */
  susp: number[];
  spin: number;
  wreck: boolean;
  fire: THREE.Mesh;
}

const DOWN = { x: 0, y: -1, z: 0 };
/** Burning below this health share. */
const FIRE_HEALTH = 0.25;

export class VehiclesView {
  readonly group = new THREE.Group();
  private readonly mats: TruckMaterials;
  /** The wreck: same model, burnt. */
  private readonly wreckMats: TruckMaterials;
  private template: THREE.Object3D;
  private wreckTemplate: THREE.Object3D | null = null;
  /** Burnt copies of a loaded model's materials (the wreck look without a wreck model). */
  private readonly burnt = new Map<THREE.Material, THREE.Material>();
  private readonly trucks = new Map<number, Instance>();
  private readonly fireMat = new THREE.MeshBasicMaterial({
    color: 0xff7a2a,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly fireGeo = new THREE.ConeGeometry(0.35, 0.9, 7, 1, true);
  /**
   * The trucks' shadow depth material, shared and compiled in `warmUp`: three's own per-material
   * depth variants would link a program the first time a truck enters the shadow camera.
   */
  private readonly depthMat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  });
  private time = 0;
  /** Tyre dust and skid marks (two pooled draws, built before warm-up). */
  readonly tyres = new TyreFx();
  /** The ground under each wheel this frame (`WHEELS` order), reused. */
  private readonly contacts: (WorldHit | null)[] = WHEELS.map(() => null);
  private readonly wheelTop = new THREE.Vector3();
  private readonly wheelGround = new THREE.Vector3();

  constructor(
    private readonly world: WorldRaycaster,
    /** Trucks to build up front (their spawns): warm-up compiles their programs. */
    spawns: readonly { id: number; x: number; y: number; z: number; yaw: number }[] = [],
  ) {
    this.mats = truckMaterials();
    this.wreckMats = truckMaterials();
    this.wreckMats.armour.color.setHex(0x1a1714);
    this.wreckMats.armour.roughness = 0.95;
    this.wreckMats.trim.color.setHex(0x0e0d0c);
    this.wreckMats.glass.opacity = 0;
    this.wreckMats.tyre.color.setHex(0x3a3633);
    this.group.name = 'vehicles';
    this.group.add(this.tyres.group);
    this.template = buildTruckPlaceholder(this.mats);
    for (const s of spawns) {
      const inst = this.instance(s.id);
      inst.root.position.set(s.x, s.y, s.z);
      inst.root.rotation.set(0, s.yaw, 0, 'YXZ');
    }
  }

  /**
   * The art lane's truck (`/models/vehicles/truck.glb`, the same node layout) in place of the
   * placeholder, if it loads and has every contract node, and its destroyed variant
   * (`truck_wreck.glb`, same layout) if that ships too. Call before warm-up.
   */
  async useModel(url: string, wreckUrl = url.replace(/\.glb$/, '_wreck.glb')): Promise<boolean> {
    const load = async (u: string): Promise<THREE.Object3D | null> => {
      try {
        const scene = (await gltfLoader().loadAsync(u)).scene;
        if (!hasTruckLayout(scene)) return null;
        scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        return scene;
      } catch {
        return null;
      }
    };
    const truck = await load(url);
    if (!truck) return false;
    this.template = truck;
    this.wreckTemplate = await load(wreckUrl);
    this.rebuildInstances();
    return true;
  }

  /** Compile the shared shadow depth program now (three's compile never reaches depth materials). */
  async warmUp(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene,
  ): Promise<void> {
    const proxy = new THREE.Mesh(this.fireGeo, this.depthMat);
    const root = new THREE.Group();
    root.add(proxy);
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace();
    const level = renderer.getActiveMipmapLevel();
    const toneMapping = renderer.toneMapping;
    const depthTarget = new THREE.WebGLRenderTarget(1, 1);
    try {
      renderer.setRenderTarget(depthTarget);
      renderer.toneMapping = THREE.NoToneMapping;
      await renderer.compileAsync(root, camera, scene);
    } finally {
      renderer.setRenderTarget(target, face, level);
      renderer.toneMapping = toneMapping;
      depthTarget.dispose();
    }
  }

  /** Draw the tyre effects' batches once for warm-up; returns the restore. */
  beginWarmUp(): () => void {
    return this.tyres.beginWarmUp();
  }

  /**
   * Rebuild every truck from the current templates, keeping each one's place. Iterates a
   * snapshot: `instance()` re-inserts each id, and a live Map iterator would revisit it forever.
   */
  rebuildInstances(): void {
    for (const [id, inst] of [...this.trucks]) {
      const at = inst.root.position.clone();
      const rot = inst.root.rotation.clone();
      this.group.remove(inst.root);
      this.trucks.delete(id);
      const fresh = this.instance(id);
      fresh.root.position.copy(at);
      fresh.root.rotation.copy(rot);
    }
  }

  private instance(id: number): Instance {
    let inst = this.trucks.get(id);
    if (inst) return inst;
    const root = new THREE.Group();
    root.name = `truck:${id}`;
    const intact = this.template.clone(true);
    root.add(intact);
    const alt = this.wreckTemplate ? this.wreckTemplate.clone(true) : null;
    if (alt) {
      alt.visible = false;
      root.add(alt);
    }
    const wheels = WHEELS.map((w) => intact.getObjectByName(WHEEL_NODE[w])!);
    for (const w of wheels) w.rotation.order = 'YXZ';
    const fire = new THREE.Mesh(this.fireGeo, this.fireMat);
    fire.position.set(0, 1.55, 1.9);
    fire.visible = false;
    root.add(fire);
    inst = {
      root,
      intact,
      alt,
      wheels,
      rest: WHEELS.map((w) => WHEEL_POS[w].y),
      susp: WHEELS.map(() => 0),
      spin: 0,
      wreck: false,
      fire,
    };
    // Opaque parts cast through the shared depth material; glass and the fire cast nothing.
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const transparent = [mesh.material].flat().some((m) => m.transparent);
      if (transparent) mesh.castShadow = false;
      else if (mesh.castShadow) mesh.customDepthMaterial = this.depthMat;
    });
    this.trucks.set(id, inst);
    this.group.add(root);
    return inst;
  }

  /**
   * Intact ↔ wreck: the destroyed variant if it shipped, else the same model burnt (placeholder:
   * its burnt material set; a loaded model: burnt copies of its own materials).
   */
  private setWreck(inst: Instance, wreck: boolean): void {
    if (inst.wreck === wreck) return;
    inst.wreck = wreck;
    if (inst.alt) {
      inst.alt.visible = wreck;
      inst.intact.visible = !wreck;
      return;
    }
    const from = wreck ? this.mats : this.wreckMats;
    const to = wreck ? this.wreckMats : this.mats;
    inst.intact.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let swapped = false;
      for (const k of ['armour', 'trim', 'glass', 'tyre'] as const) {
        if (m.material === from[k]) {
          m.material = to[k];
          swapped = true;
        }
      }
      if (swapped || Array.isArray(m.material)) return;
      // A loaded model's own material: its burnt copy (and back).
      if (wreck) {
        const src = m.material;
        let b = this.burnt.get(src);
        if (!b) {
          b = src.clone();
          const c = (b as THREE.MeshStandardMaterial).color;
          if (c) c.multiplyScalar(0.22);
          b.userData.burntFrom = src;
          this.burnt.set(src, b);
        }
        m.material = b;
      } else if (m.material.userData.burntFrom) {
        m.material = m.material.userData.burntFrom as THREE.Material;
      }
    });
  }

  /**
   * Place every truck this frame (`list`: as drawn; trucks not in it are hidden). `fx` = false
   * (a kill-cam replay) draws the trucks but lays no new dust or skid marks.
   */
  update(dt: number, list: readonly DrawnVehicle[], fx = true): void {
    this.time += dt;
    const seen = new Set<number>();
    for (const v of list) {
      seen.add(v.id);
      const inst = this.instance(v.id);
      const m = v.motion;
      inst.root.visible = v.condition !== 'gone';
      if (!inst.root.visible) continue;
      this.setWreck(inst, v.condition === 'wreck');
      inst.root.position.set(m.pos.x, m.pos.y, m.pos.z);
      // R = Ry(yaw) · Rx(−pitch) · Rz(roll): three's 'YXZ' Euler.
      inst.root.rotation.set(-m.pitch, m.yaw, m.roll, 'YXZ');
      const forward = m.vel.x * Math.sin(m.yaw) + m.vel.z * Math.cos(m.yaw);
      if (v.condition === 'active') inst.spin += (forward * dt) / TRUCK.wheelRadius;
      inst.root.updateMatrixWorld();
      WHEELS.forEach((w, i) => {
        const node = inst.wheels[i]!;
        const front = w === 'fl' || w === 'fr';
        node.rotation.set(inst.spin, front ? m.steer : 0, 0, 'YXZ');
        // Suspension: the wheel centre a radius above the ground under it (within its travel).
        const rest = WHEEL_POS[w];
        const top = this.wheelTop.set(rest.x, 1.0, rest.z).applyMatrix4(inst.root.matrixWorld);
        // Rendered ground only: on stairs the collision's smoothing ramp is invisible, and the
        // tyre (and its marks) belong on the treads drawn.
        const hit = this.world.castVisibleRay
          ? this.world.castVisibleRay(top, DOWN, 2.2)
          : this.world.castRay(top, DOWN, 2.2);
        this.contacts[i] = null;
        let off = -0.12;
        if (hit) {
          const ground = this.wheelGround.set(hit.point.x, hit.point.y, hit.point.z);
          const local = inst.root.worldToLocal(ground);
          const gap = local.y + TRUCK.wheelRadius - inst.rest[i]!;
          off = THREE.MathUtils.clamp(gap, -0.18, 0.2);
          // Tyre effects only where this wheel itself touches (not ground far under a hanging one).
          if (inWheelReach(gap)) this.contacts[i] = hit;
        }
        inst.susp[i]! += (off - inst.susp[i]!) * Math.min(1, dt * 18);
        node.position.y = inst.rest[i]! + inst.susp[i]!;
      });
      if (fx) this.tyres.truck(v.id, m, v.condition === 'active', this.contacts, dt);
      // Nearly done: the bonnet burns (a flickering flame, no light: iGPU-safe).
      const burning =
        v.condition === 'wreck' || (v.condition === 'active' && v.health < FIRE_HEALTH);
      inst.fire.visible = burning;
      if (burning) {
        const f = 0.85 + 0.15 * Math.sin(this.time * 23 + v.id) + 0.1 * Math.sin(this.time * 41);
        inst.fire.scale.set(f, f * (v.condition === 'wreck' ? 1.6 : 1), f);
      }
    }
    for (const [id, inst] of this.trucks) if (!seen.has(id)) inst.root.visible = false;
    this.tyres.update(dt);
  }
}
