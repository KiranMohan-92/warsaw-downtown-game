import * as THREE from 'three';
import { DRONE, MATCH_NET } from '@wd/shared';
import type { RemoteDrone } from '../net/onlineSession.ts';

interface DroneFigure {
  root: THREE.Group;
  battery: THREE.MeshStandardMaterial;
}

/** Other players' live recon drones. */
export class DroneView {
  readonly group = new THREE.Group();
  private readonly figures: DroneFigure[] = [];
  private readonly rotorSpin = new Array<number>(MATCH_NET.maxPlayers).fill(0);

  private readonly geo = {
    body: new THREE.BoxGeometry(0.32, 0.12, 0.22),
    nose: new THREE.BoxGeometry(0.1, 0.06, 0.16),
    arm: new THREE.BoxGeometry(0.58, 0.025, 0.025),
    rotor: new THREE.CylinderGeometry(0.11, 0.11, 0.01, 18),
    eye: new THREE.SphereGeometry(0.045, 12, 8),
  };
  private readonly mat = {
    shell: new THREE.MeshStandardMaterial({ color: '#23282f', roughness: 0.42, metalness: 0.65 }),
    arm: new THREE.MeshStandardMaterial({ color: '#111820', roughness: 0.55, metalness: 0.7 }),
    rotor: new THREE.MeshBasicMaterial({
      color: '#9ffff0',
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    eye: new THREE.MeshStandardMaterial({
      color: '#5fffd1',
      emissive: new THREE.Color('#5fffd1'),
      emissiveIntensity: 2.4,
    }),
  };

  constructor() {
    this.group.name = 'recon-drones';
    for (let i = 0; i < MATCH_NET.maxPlayers; i++) {
      const battery = this.mat.shell.clone();
      const root = this.makeDrone(battery);
      root.visible = false;
      this.group.add(root);
      this.figures.push({ root, battery });
    }
  }

  update(dt: number, drones: readonly RemoteDrone[]): void {
    for (let i = 0; i < this.figures.length; i++) {
      const f = this.figures[i]!;
      const d = drones[i];
      f.root.visible = d !== undefined;
      if (!d) continue;
      f.root.position.set(d.pos.x, d.pos.y, d.pos.z);
      f.root.rotation.set(0, d.yaw, 0);
      this.rotorSpin[i] = (this.rotorSpin[i] ?? 0) + dt * 55;
      for (const r of f.root.children.filter((o) => o.name === 'drone:rotor')) {
        r.rotation.y = this.rotorSpin[i]!;
      }
      const k = Math.max(0, Math.min(1, d.battery / DRONE.battery));
      f.battery.emissive.setRGB(0.02 + 0.18 * (1 - k), 0.18 * k, 0.08 * k);
      f.battery.emissiveIntensity = 0.8;
    }
  }

  private makeDrone(battery: THREE.MeshStandardMaterial): THREE.Group {
    const root = new THREE.Group();
    const body = new THREE.Mesh(this.geo.body, battery);
    body.name = 'drone:body';
    body.castShadow = true;
    const nose = new THREE.Mesh(this.geo.nose, this.mat.shell);
    nose.position.z = -0.17;
    nose.castShadow = true;
    const eye = new THREE.Mesh(this.geo.eye, this.mat.eye);
    eye.position.set(0, 0.015, -0.24);
    const armA = new THREE.Mesh(this.geo.arm, this.mat.arm);
    const armB = new THREE.Mesh(this.geo.arm, this.mat.arm);
    armB.rotation.y = Math.PI / 2;
    const rotors: readonly (readonly [number, number])[] = [
      [-0.29, -0.29],
      [0.29, -0.29],
      [-0.29, 0.29],
      [0.29, 0.29],
    ];
    for (const [x, z] of rotors) {
      const rotor = new THREE.Mesh(this.geo.rotor, this.mat.rotor);
      rotor.name = 'drone:rotor';
      rotor.position.set(x, 0.08, z);
      root.add(rotor);
    }
    root.add(body, nose, eye, armA, armB);
    return root;
  }
}
