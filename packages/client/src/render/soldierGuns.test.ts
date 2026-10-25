import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PRIMARY_IDS } from '@wd/shared';
import { Soldier, SOLDIER_IDS, type SoldierKit } from './soldiers.ts';
import { gltfLoader } from './gltfLoader.ts';
import {
  heldWeapon,
  PRIMARY_SCANS,
  SCAN_FITS,
  SCAN_GUN_IDS,
  thirdPersonModels,
  type HeldWeapon,
  type ScanGun,
  type ScanGunId,
} from './viewGunScans.ts';
import { DUMMY_WEAPONS } from './dummyView.ts';
import { modelDataReady, readAccessor, readModel } from './modelData.testUtil.ts';

await modelDataReady;

const soldierDir = new URL('../../public/models/soldiers/', import.meta.url);
const gunDir = new URL('../../public/models/guns/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('soldiers.json', soldierDir), 'utf8')) as {
  soldiers: Record<string, { eye: number; aimYaw: number; clips: Record<string, number> }>;
};

async function parse(id: string): Promise<SoldierKit['variants'][number]['gltf']> {
  const buf = readFileSync(new URL(`${id}.glb`, soldierDir));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => gltfLoader().parse(ab, '', resolve, reject));
}

/** A shipped scan's vertex positions (scan coordinates, before its SCAN_FITS offset). */
function positions(id: ScanGunId): THREE.Vector3[] {
  const model = readModel(new URL(`${id}.gltf`, gunDir));
  const p = readAccessor(model, model.json.meshes[0]!.primitives[0]!.attributes.POSITION!).data;
  return Array.from(
    { length: p.length / 3 },
    (_, i) => new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]),
  );
}

// The soldier's skateboard draws its grip tape on a canvas: a minimal stand-in for node.
const fakeCanvas = {
  width: 0,
  height: 0,
  getContext: () => ({ fillStyle: '', fillRect: () => {} }),
};

let kit: SoldierKit;
const scans = new Map<ScanGunId, ScanGun>(
  SCAN_GUN_IDS.map((id) => [
    id,
    {
      geometry: new THREE.BoxGeometry(0.05, 0.1, 0.6),
      material: new THREE.MeshStandardMaterial({ name: `gun:${id}` }),
    },
  ]),
);

beforeAll(async () => {
  vi.stubGlobal('document', { createElement: () => fakeCanvas });
  const variants = await Promise.all(
    SOLDIER_IDS.map(async (id) => ({
      id,
      gltf: await parse(id),
      material: new THREE.MeshStandardMaterial(),
      info: manifest.soldiers[id] as unknown as SoldierKit['variants'][number]['info'],
    })),
  );
  kit = {
    variants,
    gearMaterial: new THREE.MeshStandardMaterial(),
    guns: thirdPersonModels(scans),
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const pose = (weapon: HeldWeapon) => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  crouched: false,
  grounded: true,
  sprinting: false,
  alive: true,
  weapon,
});

/** Meshes of `s` that would draw a held weapon. */
const drawnGuns = (s: Soldier): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  s.root.traverseVisible((o) => {
    if (o.name.startsWith('held:')) out.push(o as THREE.Mesh);
  });
  return out;
};

describe('third-person weapons', () => {
  it('maps the weapon in hand to its model: primary, pistol, knife', () => {
    for (const p of PRIMARY_IDS) expect(heldWeapon('rifle', p)).toBe(PRIMARY_SCANS[p]);
    expect(heldWeapon('sidearm', 'shotgun')).toBe('pistol');
    expect(heldWeapon('knife', 'marksman')).toBe('knife');
    // Every primary has a scan (a new primary needs one, or it would draw the AR-7).
    expect(new Set(Object.values(PRIMARY_SCANS)).size).toBe(PRIMARY_IDS.length);
  });

  it('holds exactly one weapon (one extra draw) and swaps it without new geometry or materials', () => {
    const a = new Soldier(kit, 0);
    const b = new Soldier(kit, 1);
    expect(a.weapon).toBe('rifle');
    expect(drawnGuns(a).map((m) => m.name)).toEqual(['held:rifle']);
    for (const w of [...SCAN_GUN_IDS, 'knife'] as const) {
      a.update(pose(w), 1 / 60);
      b.setWeapon(w);
      const [ma, ...rest] = drawnGuns(a);
      expect(rest, w).toHaveLength(0);
      expect(ma!.name).toBe(`held:${w}`);
      const [mb] = drawnGuns(b);
      // Shared across soldiers: the scan's geometry, and one material per gun for all soldiers.
      expect(ma!.geometry).toBe(mb!.geometry);
      expect(ma!.material).toBe(mb!.material);
      if (w !== 'knife') {
        expect(ma!.geometry).toBe(scans.get(w)!.geometry);
        // ...but never the viewmodel's material: that one is lamp-lit at the world camera
        // ('camera' mode), the soldiers' at their own position ('world' mode).
        expect(ma!.material).not.toBe(scans.get(w)!.material);
      }
    }
  });

  it('puts every gun’s grip in the right hand and its barrel along the aim', () => {
    for (const variant of [0, 1]) {
      const s = new Soldier(kit, variant);
      s.update(pose('rifle'), 1 / 60);
      s.root.updateMatrixWorld(true);
      const hand = s.root.getObjectByName('Bip01_R_Hand')!.getWorldPosition(new THREE.Vector3());
      const o = s.root.getObjectByName('gun_o')!.getWorldPosition(new THREE.Vector3());
      const f = s.root.getObjectByName('gun_f')!.getWorldPosition(new THREE.Vector3());
      const aim = f.clone().sub(o).normalize();
      let rifleGrip: THREE.Vector3 | null = null;
      for (const id of SCAN_GUN_IDS) {
        s.setWeapon(id);
        const mesh = drawnGuns(s)[0]!;
        mesh.updateMatrixWorld(true);
        // The scan's measured grip anchor (gun space → scan space = minus its offset).
        const fit = SCAN_FITS[id];
        const gripScan = new THREE.Vector3(...fit.hands[0]!.at).sub(
          new THREE.Vector3(...fit.offset),
        );
        const grip = gripScan.applyMatrix4(mesh.matrixWorld);
        expect(grip.distanceTo(hand), `${variant} ${id} grip ↔ hand`).toBeLessThan(0.12);
        // Exactly where the rifle's grip sits (the hand was posed on the rifle).
        rifleGrip ??= grip.clone();
        expect(grip.distanceTo(rifleGrip), `${variant} ${id} grip = rifle grip`).toBeLessThan(
          0.002,
        );
        // Bore along -Z in gun space → along gun_o → gun_f in the world.
        const bore = new THREE.Vector3(0, 0, -1).transformDirection(mesh.matrixWorld);
        expect(bore.dot(aim), `${variant} ${id} barrel`).toBeGreaterThan(0.999);
        // The muzzle is ahead of the hand, never behind it.
        const muzzle = new THREE.Vector3(0, fit.flash.y, fit.flash.z)
          .sub(new THREE.Vector3(...fit.offset))
          .applyMatrix4(mesh.matrixWorld);
        expect(muzzle.clone().sub(hand).dot(aim), `${variant} ${id} muzzle ahead`).toBeGreaterThan(
          0.08,
        );
      }
    }
  });

  it('SCAN_FITS grip anchors and muzzles are on the real scans (what the fit relies on)', () => {
    for (const id of SCAN_GUN_IDS) {
      const fit = SCAN_FITS[id];
      const pts = positions(id);
      const grip = new THREE.Vector3(...fit.hands[0]!.at).sub(new THREE.Vector3(...fit.offset));
      const nearest = Math.min(...pts.map((p) => p.distanceTo(grip)));
      expect(nearest, `${id} grip anchor on the mesh`).toBeLessThan(0.05);
      const front = Math.min(...pts.map((p) => p.z)) + fit.offset[2];
      expect(Math.abs(front - fit.flash.z), `${id} muzzle`).toBeLessThan(0.08);
    }
  });

  it('dummies show off the whole arsenal', () => {
    expect(new Set(DUMMY_WEAPONS)).toEqual(new Set([...SCAN_GUN_IDS, 'knife']));
  });
});
