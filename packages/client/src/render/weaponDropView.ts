import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PRIMARY_IDS, WEAPON_DROP, type PrimaryId, type WeaponDropState } from '@wd/shared';
import { PRIMARY_SCANS, wholeGun, type ScanGuns } from './viewGunScans.ts';
import { buildCoilgun, buildIskra, buildRifle, MAT, type GunModel } from './viewmodelModels.ts';

type DropMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
interface DropSlot {
  root: THREE.Group;
  guns: Record<PrimaryId, DropMesh>;
  id: string | null;
  primary: PrimaryId | null;
}

/** The existing primitive gun body, without its arms, glass or muzzle flash (load failure only). */
function fallbackGeometry(model: GunModel): THREE.BufferGeometry {
  model.group.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  model.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const material = o.material as THREE.MeshStandardMaterial;
    if (material.transparent || material === MAT.glove || material === MAT.sleeve) return;
    const source = o.geometry as THREE.BufferGeometry;
    const geometry = (source.index ? source.toNonIndexed() : source.clone()).applyMatrix4(
      o.matrixWorld,
    );
    const color = new Float32Array(geometry.getAttribute('position').count * 3);
    for (let i = 0; i < color.length; i += 3) {
      color[i] = material.color.r;
      color[i + 1] = material.color.g;
      color[i + 2] = material.color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
    parts.push(geometry);
  });
  const merged = mergeGeometries(parts);
  for (const geometry of parts) geometry.dispose();
  if (!merged) throw new Error('weapon drop fallback geometry');
  return merged;
}

/**
 * A fixed pool of whole third-person gun meshes. All six variants and their fade materials
 * exist before warm-up; snapshots only select meshes and update transforms/uniforms. At most
 * one mesh per live drop draws, with no extra outline pass or runtime shader changes.
 */
export class WeaponDropView {
  readonly group = new THREE.Group();
  private readonly slots: DropSlot[] = [];
  private time = 0;

  constructor() {
    this.group.name = 'weaponDrops';
    const rifle = fallbackGeometry(buildRifle());
    const coil = fallbackGeometry(buildCoilgun());
    const iskra = fallbackGeometry(buildIskra());
    const fallback: Record<PrimaryId, THREE.BufferGeometry> = {
      ar7: rifle,
      coil,
      iskra,
      shotgun: rifle,
      marksman: coil,
      arc: iskra,
    };
    for (let i = 0; i < WEAPON_DROP.cap; i++) {
      const root = new THREE.Group();
      root.visible = false;
      const guns = {} as Record<PrimaryId, DropMesh>;
      for (const primary of PRIMARY_IDS) {
        const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 });
        this.prepareMaterial(material);
        const mesh = new THREE.Mesh(fallback[primary], material);
        mesh.name = `drop:${primary}`;
        mesh.visible = false;
        mesh.receiveShadow = true;
        this.placeOnSide(mesh);
        guns[primary] = mesh;
        root.add(mesh);
      }
      this.slots.push({ root, guns, id: null, primary: null });
      this.group.add(root);
    }
  }

  /** Same whole gun geometry as soldiers; copies only the material for independent fading. */
  useScannedGuns(scans: ScanGuns): void {
    for (const slot of this.slots)
      for (const primary of PRIMARY_IDS) {
        const scan = scans.get(PRIMARY_SCANS[primary]);
        if (!scan) continue;
        const mesh = slot.guns[primary];
        mesh.geometry = wholeGun(scan);
        mesh.material.copy(scan.material);
        this.prepareMaterial(mesh.material);
        this.placeOnSide(mesh);
      }
  }

  private prepareMaterial(material: THREE.MeshStandardMaterial): void {
    material.name = 'weaponDrop';
    // Keep the transparent program from the first draw, even before the final fade begins.
    material.transparent = true;
    material.depthWrite = false;
    material.emissive.set('#679d94');
    material.emissiveIntensity = 0.08;
  }

  private placeOnSide(mesh: DropMesh): void {
    mesh.geometry.computeBoundingBox();
    const bounds = mesh.geometry.boundingBox!;
    mesh.rotation.z = Math.PI / 2;
    mesh.position.set(
      (bounds.min.y + bounds.max.y) / 2,
      0.025 - bounds.min.x,
      -(bounds.min.z + bounds.max.z) / 2,
    );
  }

  update(dt: number, drops: readonly WeaponDropState[]): void {
    this.time += dt;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const drop = drops[i];
      slot.root.visible = !!drop && drop.ttl > 0;
      if (!drop) continue;
      if (slot.primary !== drop.primary) {
        if (slot.primary) slot.guns[slot.primary].visible = false;
        slot.guns[drop.primary].visible = true;
        slot.primary = drop.primary;
      }
      if (slot.id !== drop.id) {
        let hash = 0;
        for (let c = 0; c < drop.id.length; c++) hash = (hash * 31 + drop.id.charCodeAt(c)) | 0;
        slot.root.rotation.y = (hash % 628) / 100;
        slot.id = drop.id;
      }
      slot.root.position.set(drop.pos.x, drop.pos.y, drop.pos.z);
      const material = slot.guns[drop.primary].material;
      material.opacity = Math.max(0, Math.min(1, drop.ttl / 2));
      material.emissiveIntensity = 0.08 + Math.sin(this.time * 1.6 + i) * 0.035;
    }
  }

  /** Draw every pooled variant through Game's real warm-up passes, then restore selection. */
  beginWarmUp(): () => void {
    const hidden: THREE.Object3D[] = [];
    this.group.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    return () => {
      for (const o of hidden) o.visible = false;
    };
  }
}
