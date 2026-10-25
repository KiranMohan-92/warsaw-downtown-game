import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ACTION_RELEASE,
  GRENADE,
  KNIFE,
  KNIFE_DEFENSE,
  RIFLE,
  SIDEARM,
  type PlayerAction,
} from '@wd/shared';
import { LAYER_ROOT, Soldier, SOLDIER_IDS, upperBones, type SoldierKit } from './soldiers.ts';
import { ACTION_CLIPS, actionClipTime, pickActionClip, type ActionClip } from './soldierActions.ts';
import { gltfLoader } from './gltfLoader.ts';
import { thirdPersonKnife } from './viewGunScans.ts';

const dir = new URL('../../public/models/soldiers/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('soldiers.json', dir), 'utf8')) as {
  soldiers: Record<
    string,
    { eye: number; aimYaw: number; clips: Record<string, number>; marks: Record<string, number> }
  >;
};

async function parse(id: string): Promise<SoldierKit['variants'][number]['gltf']> {
  const buf = readFileSync(new URL(`${id}.glb`, dir));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => gltfLoader().parse(ab, '', resolve, reject));
}

const FRAME = 1 / 30 + 1e-4; // the build samples at the scene's 30 fps

describe('action clip choice and timing', () => {
  const s = { crouched: false, speed: 0, alive: true };
  const A = (kind: PlayerAction['kind'], t = 0.5, v = 0): PlayerAction => ({ kind, v, t });

  it('picks the reload by stance and speed, the pistol by variant; none prone or dead', () => {
    expect(pickActionClip(A('reload'), s)).toBe('reload');
    expect(pickActionClip(A('reload'), { ...s, crouched: true })).toBe('reloadKneel');
    expect(pickActionClip(A('reload'), { ...s, speed: 3 })).toBe('reloadRun');
    expect(pickActionClip(A('reload', 0.5, 1), { ...s, speed: 3 })).toBe('reloadPistol');
    expect(pickActionClip(A('throw'), s)).toBe('throw');
    expect(pickActionClip(A('strike'), s)).toBe('strike');
    expect(pickActionClip(A('guard'), s)).toBe('guard');
    expect(pickActionClip(A('stun'), s)).toBe('hit');
    expect(pickActionClip(A('none'), s)).toBeNull();
    expect(pickActionClip(A('reload'), { ...s, prone: true })).toBeNull();
    expect(pickActionClip(A('reload'), { ...s, alive: false })).toBeNull();
  });

  it('lands the sim release on the clip mark and ends with the sim; a backhand runs backwards', () => {
    const marks = { throw: 0.3, strike: 0.2 };
    expect(actionClipTime(A('throw', 0), 'throw', 0.7, marks)).toBe(0);
    expect(actionClipTime(A('throw', ACTION_RELEASE), 'throw', 0.7, marks)).toBeCloseTo(0.3);
    expect(actionClipTime(A('throw', 1), 'throw', 0.7, marks)).toBeCloseTo(0.7);
    expect(actionClipTime(A('throw', 0.75), 'throw', 0.7, marks)).toBeCloseTo(0.5);
    expect(actionClipTime(A('strike', 0, 1), 'strike', 0.5, marks)).toBeCloseTo(0.5);
    expect(actionClipTime(A('strike', ACTION_RELEASE, 1), 'strike', 0.5, marks)).toBeCloseTo(0.2);
    expect(actionClipTime(A('strike', 1, 1), 'strike', 0.5, marks)).toBeCloseTo(0);
    expect(actionClipTime(A('reload', 0.25), 'reload', 2, marks)).toBeCloseTo(0.5);
    expect(actionClipTime(A('reload', 1.5), 'reload', 2, marks)).toBeCloseTo(2);
  });

  it('ships every action clip, baked to the sim durations in tunables (soldiers.json)', () => {
    for (const id of SOLDIER_IDS) {
      const { clips, marks } = manifest.soldiers[id]!;
      for (const c of ACTION_CLIPS) expect(clips[c], `${id} ${c}`).toBeGreaterThan(0);
      const near = (a: number | undefined, b: number, what: string): void => {
        expect(Math.abs(a! - b), `${id} ${what}: ${a} vs ${b}`).toBeLessThan(FRAME);
      };
      near(clips.reload, RIFLE.reloadTime, 'reload');
      near(clips.reloadKneel, RIFLE.reloadTime, 'reloadKneel');
      near(clips.reloadRun, RIFLE.reloadTime, 'reloadRun');
      near(clips.reloadPistol, SIDEARM.reloadTime, 'reloadPistol');
      near(clips.throw, GRENADE.windup + GRENADE.recovery, 'throw');
      near(marks.throw, GRENADE.windup, 'throw release');
      near(clips.strike, KNIFE.openingWindup + KNIFE.recovery, 'strike');
      near(marks.strike, KNIFE.openingWindup, 'strike impact');
      near(clips.guard, KNIFE_DEFENSE.parryWindow, 'guard');
    }
  });
});

// The soldier's skateboard draws its grip tape on a canvas: a minimal stand-in for node.
const fakeCanvas = {
  width: 0,
  height: 0,
  getContext: () => ({ fillStyle: '', fillRect: () => {} }),
};
let kit: SoldierKit;

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
    guns: {
      rifle: {
        geometry: new THREE.BoxGeometry(0.05, 0.1, 0.6),
        material: new THREE.MeshStandardMaterial(),
        position: new THREE.Vector3(),
      },
      knife: thirdPersonKnife(),
    },
    grenade: {
      geometry: new THREE.SphereGeometry(0.035),
      material: new THREE.MeshStandardMaterial(),
    },
  };
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const pose = (extra: Partial<Parameters<Soldier['update']>[0]> = {}) => ({
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  crouched: false,
  grounded: true,
  sprinting: false,
  alive: true,
  hp: 100,
  ...extra,
});

/** Run a soldier for `s` seconds at 60 Hz with a fixed pose. */
function play(soldier: Soldier, s: number, p: ReturnType<typeof pose>): void {
  for (let t = 0; t < s; t += 1 / 60) soldier.update(p, 1 / 60);
  soldier.root.updateMatrixWorld(true);
}

const at = (s: Soldier, bone: string): THREE.Vector3 =>
  s.root.getObjectByName(bone)!.getWorldPosition(new THREE.Vector3());
const up = (s: Soldier, bone: string): THREE.Vector3 =>
  new THREE.Vector3(0, 1, 0).applyQuaternion(
    s.root.getObjectByName(bone)!.getWorldQuaternion(new THREE.Quaternion()),
  );
const visible = (o: THREE.Object3D | null | undefined): boolean => {
  for (let x = o; x; x = x.parent) if (!x.visible) return false;
  return !!o;
};

describe('soldier action layers', () => {
  it('layer clips carry only upper-body tracks (the build drops the rest)', async () => {
    const g = await parse('m01');
    const upper = upperBones(g.scene);
    for (const name of ACTION_CLIPS) {
      const clip = g.animations.find((c) => c.name === name)!;
      expect(clip, name).toBeDefined();
      for (const t of clip.tracks) {
        expect(upper.has(t.name.slice(0, t.name.lastIndexOf('.'))), `${name} ${t.name}`).toBe(true);
      }
      expect(clip.tracks.some((t) => t.name === `${LAYER_ROOT.replace(' ', '_')}.quaternion`)).toBe(
        true,
      );
    }
  });

  it('a reload moves the support hand off the grip and back, over the legs of any stance', () => {
    const s = new Soldier(kit, 0);
    play(s, 0.5, pose());
    const rest = at(s, 'Bip01_L_Hand');
    play(s, 0.4, pose({ action: { kind: 'reload', v: 0, t: 0.3 } }));
    expect(s.actionClip).toBe('reload' satisfies ActionClip);
    expect(at(s, 'Bip01_L_Hand').distanceTo(rest)).toBeGreaterThan(0.1);
    const standingChest = up(s, 'Bip01_Spine2');
    // Crouched: the kneeling variant, its chest set in model space (not bent over by the crouch).
    const k = new Soldier(kit, 0);
    play(k, 0.6, pose({ crouched: true, action: { kind: 'reload', v: 0, t: 0.3 } }));
    expect(k.actionClip).toBe('reloadKneel');
    expect(up(k, 'Bip01_Spine2').angleTo(standingChest)).toBeLessThan(THREE.MathUtils.degToRad(15));
    // Done: the layer fades out and the hand returns to the rifle hold.
    play(s, 0.5, pose());
    expect(s.actionClip).toBeNull();
    expect(at(s, 'Bip01_L_Hand').distanceTo(rest)).toBeLessThan(0.03);
  });

  it('a throw shows the frag in hand until release (weapon away); a strike draws the knife', () => {
    const s = new Soldier(kit, 1);
    play(s, 0.3, pose());
    expect(s.heldMesh()?.name).toBe('held:rifle');
    play(s, 0.2, pose({ action: { kind: 'throw', v: 0, t: 0.3 } }));
    expect(s.actionClip).toBe('throw');
    expect(visible(s.grenadeMesh)).toBe(true);
    expect(visible(s.heldMesh())).toBe(false);
    play(s, 0.1, pose({ action: { kind: 'throw', v: 0, t: 0.7 } }));
    expect(visible(s.grenadeMesh)).toBe(false);
    play(s, 0.1, pose({ action: { kind: 'strike', v: 0, t: 0.3 } }));
    expect(s.actionClip).toBe('strike');
    expect(visible(s.root.getObjectByName('held:knife'))).toBe(true);
    expect(visible(s.root.getObjectByName('held:rifle'))).toBe(false);
    play(s, 0.5, pose());
    expect(visible(s.root.getObjectByName('held:rifle'))).toBe(true);
  });

  it('flinches on a health drop (heavy hits harder), not on heals or respawns', () => {
    const s = new Soldier(kit, 0);
    play(s, 0.3, pose());
    const chest = up(s, 'Bip01_Spine2');
    s.update(pose({ hp: 75 }), 1 / 60);
    play(s, 0.1, pose({ hp: 75 }));
    expect(s.flinchClip).toBe('hit');
    const light = up(s, 'Bip01_Spine2').angleTo(chest);
    expect(light).toBeGreaterThan(THREE.MathUtils.degToRad(3));
    play(s, 0.6, pose({ hp: 75 }));
    expect(s.flinchClip).toBeNull();
    s.update(pose({ hp: 25 }), 1 / 60);
    play(s, 0.1, pose({ hp: 25 }));
    expect(s.flinchClip).toBe('hitHead');
    expect(up(s, 'Bip01_Spine2').angleTo(chest)).toBeGreaterThan(light);
    play(s, 0.6, pose({ hp: 100 })); // a heal
    expect(s.flinchClip).toBeNull();
  });

  it('a stun landing mid-flinch keeps its own layer running (one action per clip)', () => {
    const s = new Soldier(kit, 0);
    play(s, 0.3, pose());
    s.update(pose({ hp: 75 }), 1 / 60); // light hit: the chest flinch ('hit') starts
    play(s, 0.1, pose({ hp: 75 }));
    expect(s.flinchClip).toBe('hit');
    // Stunned while the flinch still plays: the stun plays the same chest hit as its action.
    const stun = pose({ hp: 75, action: { kind: 'stun', v: 0, t: 0.2 } });
    play(s, 0.5, stun);
    expect(s.actionClip).toBe('hit');
    const layer = (s as unknown as { actionLayer: { action: THREE.AnimationAction | null } })
      .actionLayer;
    expect(layer.action).not.toBeNull();
    expect(layer.action!.isRunning() || layer.action!.paused).toBe(true);
    expect(layer.action!.getEffectiveWeight()).toBeGreaterThan(0);
    expect(s.flinchClip).not.toBe('hit'); // the flinch let go of it
  });
});
