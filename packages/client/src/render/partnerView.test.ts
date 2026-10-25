import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyKnifeStrike,
  Button,
  createPlayerState,
  KNIFE,
  PLAYER,
  stepArsenal,
  type PlayerInput,
  type PlayerState,
} from '@wd/shared';
import { gltfLoader } from './gltfLoader.ts';
import { SOLDIER_IDS, type SoldierKit } from './soldiers.ts';
import {
  armBones,
  facingToWorld,
  handOffset,
  mixArm,
  partnerPose,
  partnerSoldierPose,
  PartnerView,
  poseArm,
  type ArmBones,
  type ArmPose,
} from './partnerView.ts';

const DT = 1 / 60;
const knifer = (): PlayerState => createPlayerState({ x: 0, y: 0, z: 0 }, 7, 'knife');
const input = (buttons: number): PlayerInput => ({
  seq: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons,
});
/** Run the real arsenal state machine for `seconds` with `buttons` held. */
function hold(s: PlayerState, buttons: number, seconds: number, prev = 0): number {
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    stepArsenal(s.arsenal, input(buttons), prev, DT);
    prev = buttons;
  }
  return prev;
}
const handUp = (arm: ArmPose): number => handOffset(arm)[2];
const handFwd = (arm: ArmPose): number => handOffset(arm)[0];

describe('partner pose (knife state → body)', () => {
  it('rests with the knife low and ready: no glint, no guard, no stagger', () => {
    const p = partnerPose(knifer());
    expect(p.glint).toBe(0);
    expect(p.guard).toBe(false);
    expect(p.stagger).toBe(0);
    expect(p.chambering).toBe(false);
    expect(handFwd(p.knife)).toBeGreaterThan(0.2); // knife held out in front
  });

  it('the opening strike chambers: a big visible arm raise and a blade glint', () => {
    const rest = partnerPose(knifer());
    const s = knifer();
    hold(s, Button.Fire, KNIFE.openingWindup * 0.5);
    expect(s.arsenal.melee.phase).toBe('windup');
    expect(s.arsenal.melee.move).toBe('slash');
    const p = partnerPose(s);
    expect(p.chambering).toBe(true);
    expect(p.glint).toBeGreaterThan(0.3);
    // The hand rises well above the ready guard (over the shoulder) — readable at knife range.
    expect(handUp(p.knife) - handUp(rest.knife)).toBeGreaterThan(0.3);
    expect(handUp(p.knife)).toBeGreaterThan(0.2);
  });

  it('chambers from early on, so the tell is visible for most of the 0.22 s', () => {
    const rest = partnerPose(knifer());
    const s = knifer();
    hold(s, Button.Fire, KNIFE.openingWindup * 0.3);
    expect(s.arsenal.melee.phase).toBe('windup');
    expect(handUp(partnerPose(s).knife) - handUp(rest.knife)).toBeGreaterThan(0.2);
  });

  it('follow-ups and counters do not glint (only the opening chamber is the tell)', () => {
    const s = knifer();
    // Opening strike through its wind-up and recovery, then keep slashing: a fast follow-up.
    const prev = hold(s, Button.Fire, KNIFE.openingWindup + KNIFE.recovery + DT);
    hold(s, Button.Fire, DT * 2, prev);
    expect(s.arsenal.melee.phase).toBe('windup');
    expect(s.arsenal.melee.windupTotal).toBe(KNIFE.windup);
    expect(s.arsenal.melee.move).toBe('backhand');
    const p = partnerPose(s);
    expect(p.chambering).toBe(false);
    expect(p.glint).toBe(0);

    const c = knifer();
    c.arsenal.counter = 0.5;
    hold(c, Button.Fire, DT);
    expect(c.arsenal.melee.windupTotal).toBe(KNIFE.counterWindup);
    expect(partnerPose(c).glint).toBe(0);
  });

  it('a thrust chambers by pulling the hand back, then drives it out', () => {
    const rest = partnerPose(knifer());
    const s = knifer();
    s.arsenal.melee = {
      ...s.arsenal.melee,
      phase: 'windup',
      move: 'thrust',
      windupTotal: KNIFE.openingWindup,
      timer: KNIFE.openingWindup * 0.4,
    };
    const chamber = partnerPose(s);
    expect(handFwd(rest.knife) - handFwd(chamber.knife)).toBeGreaterThan(0.2);
    s.arsenal.melee = { ...s.arsenal.melee, phase: 'recover', timer: KNIFE.recovery * 0.8 };
    const out = partnerPose(s);
    expect(handFwd(out.knife)).toBeGreaterThan(0.5); // arm driven straight out
  });

  it('the slash swings through the front and across to the other side', () => {
    const s = knifer();
    const at = (k: number): ArmPose => {
      s.arsenal.melee = {
        ...s.arsenal.melee,
        phase: 'recover',
        move: 'slash',
        timer: KNIFE.recovery * (1 - k),
      };
      return partnerPose(s).knife;
    };
    expect(handFwd(at(0.12))).toBeGreaterThan(0.45); // mid-swing: in front
    expect(handOffset(at(0.25))[1]).toBeLessThan(0); // ends across the body (to its left)
  });

  it('Block raises the left forearm across in front of the face', () => {
    const rest = partnerPose(knifer());
    const s = knifer();
    hold(s, Button.Block, DT * 3);
    expect(s.arsenal.guard.held).toBe(true);
    const p = partnerPose(s);
    expect(p.guard).toBe(true);
    expect(handUp(p.off) - handUp(rest.off)).toBeGreaterThan(0.3);
    expect(handUp(p.off)).toBeGreaterThan(0.1); // above the shoulder: face height
    expect(handOffset(p.off)[1]).toBeGreaterThan(0); // crosses the centre line
    expect(handFwd(p.off)).toBeGreaterThan(0.1); // in front of the face
  });

  it('a parried attacker staggers (stun from the real knife-defense rules)', () => {
    const attacker = knifer();
    const defender = createPlayerState({ x: 0, y: 0, z: -1.5 }, 3, 'knife');
    defender.view.yaw = Math.PI; // facing the attacker (+Z)
    hold(defender, Button.Block, DT * 2); // raised just before impact: parry window
    const res = applyKnifeStrike(attacker, defender, 'slash');
    expect(res.outcome).toBe('parried');
    const p = partnerPose(attacker);
    expect(p.stagger).toBe(1);
    // Arms thrown off line: the knife hand leaves the ready guard.
    const rest = partnerPose(knifer());
    expect(Math.abs(handOffset(p.knife)[1] - handOffset(rest.knife)[1])).toBeGreaterThan(0.1);
    // Stagger fades with the stun.
    attacker.arsenal.stun *= 0.5;
    expect(partnerPose(attacker).stagger).toBeCloseTo(0.5, 5);
  });

  it('a broken guard drops the forearm and staggers the defender', () => {
    const attacker = knifer();
    const defender = createPlayerState({ x: 0, y: 0, z: -1.5 }, 3, 'knife');
    defender.view.yaw = Math.PI;
    hold(defender, Button.Block, 0.5); // past the parry window: blocks
    const outcomes = [0, 1, 2].map(() => applyKnifeStrike(attacker, defender, 'slash').outcome);
    expect(outcomes).toEqual(['blocked', 'blocked', 'guardBroken']);
    const p = partnerPose(defender);
    expect(p.guard).toBe(false);
    expect(p.stagger).toBeGreaterThan(0);
  });

  it('drives the soldier from the PlayerState exactly like a remote player snapshot', () => {
    const prev = knifer();
    const cur = knifer();
    cur.move.pos = { x: 2, y: 0.5, z: -4 };
    cur.view.yaw = 1.2;
    cur.view.pitch = -0.1;
    cur.move.crouched = true;
    cur.move.grounded = false;
    cur.move.sprinting = true;
    const sp = partnerSoldierPose(cur, prev, 0.5);
    expect(sp).toMatchObject({
      x: 1,
      y: 0.25,
      z: -2,
      yaw: 1.2,
      pitch: -0.1,
      crouched: true,
      grounded: false,
      sprinting: true,
      riding: false,
      prone: false,
      alive: true,
    });
    cur.health = 0;
    expect(partnerSoldierPose(cur, prev, 1).alive).toBe(false);
  });

  it('keeps the capsule figure when no soldiers are loaded', () => {
    const v = new PartnerView();
    expect(v.usesSoldier).toBe(false);
    const s = knifer();
    v.update(DT, s, s, 1, 0);
    expect(v.group.visible).toBe(true);
    s.health = 0;
    v.update(DT, s, s, 1, 0);
    expect(v.group.visible).toBe(false);
  });
});

describe('partner arm overlay on the real soldier skeleton', () => {
  const dir = new URL('../../public/models/soldiers/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('soldiers.json', dir), 'utf8')) as {
    soldiers: Record<string, { eye: number; aimYaw: number }>;
  };

  async function posed(clip: string): Promise<THREE.Object3D> {
    const buf = readFileSync(new URL('m04.glb', dir));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const g = await new Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>(
      (res, rej) => gltfLoader().parse(ab, '', res, rej),
    );
    const root = new THREE.Group();
    const model = g.scene;
    model.scale.setScalar(PLAYER.standEyeHeight / manifest.soldiers.m04!.eye);
    // Facing yaw 0 (-Z), bladed like Soldier.update (the model itself faces +Z).
    model.rotation.y = Math.PI - manifest.soldiers.m04!.aimYaw;
    root.add(model);
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(g.animations.find((c) => c.name === clip)!).play();
    mixer.setTime(0.5);
    root.updateMatrixWorld(true);
    return root;
  }
  const world = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());

  it('finds both arm chains on the Rocketbox biped', async () => {
    const root = await posed('idle');
    expect(armBones(root, 'R')).not.toBeNull();
    expect(armBones(root, 'L')).not.toBeNull();
  });

  it('points the bones where the pose says, at any facing (the hand lands on handOffset)', async () => {
    for (const yaw of [0, 1.3, -2.4]) {
      const root = await posed('walk');
      const r = armBones(root, 'R')!;
      const arm: ArmPose = { upper: [-0.35, 0.75, 0.45], fore: [-0.15, 0.25, 0.95] };
      poseArm(r, arm, yaw);
      const u = world(r.fore).sub(world(r.upper)).normalize();
      const f = world(r.hand).sub(world(r.fore)).normalize();
      expect(u.dot(facingToWorld(arm.upper, yaw))).toBeGreaterThan(0.999);
      expect(f.dot(facingToWorld(arm.fore, yaw))).toBeGreaterThan(0.999);
      // handOffset's arm lengths match the skeleton at game scale (within a few cm).
      const hand = world(r.hand).sub(world(r.upper));
      const expected = handOffset(arm);
      const exp = facingToWorld([expected[0], expected[1], expected[2]], yaw).multiplyScalar(
        Math.hypot(...expected),
      );
      expect(hand.distanceTo(exp)).toBeLessThan(0.06);
    }
  });

  it('chamber lifts the knife hand over the head; the guard puts the left hand at the face', async () => {
    const s = knifer();
    const rest = await posed('idle');
    const rr = armBones(rest, 'R')!;
    poseArm(rr, partnerPose(s).knife, 0);
    const restHand = world(rr.hand).y;

    s.arsenal.melee = {
      ...s.arsenal.melee,
      phase: 'windup',
      move: 'slash',
      windupTotal: KNIFE.openingWindup,
      timer: KNIFE.openingWindup * 0.4,
    };
    const ch = await posed('idle');
    const cr = armBones(ch, 'R')!;
    poseArm(cr, partnerPose(s).knife, 0);
    const head = world(ch.getObjectByName('Bip01_Head')!).y;
    expect(world(cr.hand).y - restHand).toBeGreaterThan(0.3);
    expect(world(cr.hand).y).toBeGreaterThan(head);

    const g = knifer();
    hold(g, Button.Block, DT * 3);
    const gu = await posed('idle');
    const gl = armBones(gu, 'L')!;
    poseArm(gl, partnerPose(g).off, 0);
    const gHead = world(gu.getObjectByName('Bip01_Head')!);
    const lh = world(gl.hand);
    expect(Math.abs(lh.y - gHead.y)).toBeLessThan(0.15);
    expect(gHead.z - lh.z).toBeGreaterThan(0.1); // in front of the face (yaw 0 faces -Z)
  });

  it('blends with the clip by weight (0 leaves the clip arm untouched)', async () => {
    const root = await posed('idle');
    const r = armBones(root, 'R')!;
    const before = world(r.hand);
    poseArm(r, mixArm(partnerPose(knifer()).knife, partnerPose(knifer()).knife, 0), 0, 0);
    expect(world(r.hand).distanceTo(before)).toBeLessThan(1e-9);
  });
});

describe('partner arm overlay over a still clip (the real partner)', () => {
  const dir = new URL('../../public/models/soldiers/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('soldiers.json', dir), 'utf8')) as {
    soldiers: Record<string, unknown>;
  };
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
      SOLDIER_IDS.map(async (id) => {
        const buf = readFileSync(new URL(`${id}.glb`, dir));
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        const gltf = await new Promise<SoldierKit['variants'][number]['gltf']>((res, rej) =>
          gltfLoader().parse(ab, '', res, rej),
        );
        return {
          id,
          gltf,
          material: new THREE.MeshStandardMaterial(),
          info: manifest.soldiers[id] as SoldierKit['variants'][number]['info'],
        };
      }),
    );
    kit = { variants, gearMaterial: new THREE.MeshStandardMaterial(), guns: {} };
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  type Inner = { soldier: { mixer: THREE.AnimationMixer }; arms: { r: ArmBones; l: ArmBones } };
  /** Standing on the ground (a fresh state is airborne: the jump clip). */
  const standing = (): PlayerState => {
    const s = knifer();
    s.move.grounded = true;
    return s;
  };
  let time = 0;
  const step = (v: PartnerView, s: PlayerState, frames = 1): void => {
    for (let i = 0; i < frames; i++) v.update(DT, s, s, 1, (time += DT));
  };
  /** A soldier partner settled at rest, then its clip frozen: three's mixer stops writing. */
  function frozen(s = standing()): PartnerView {
    const v = new PartnerView();
    v.useSoldiers(kit);
    step(v, s, 20);
    (v as unknown as Inner).soldier.mixer.timeScale = 0;
    return v;
  }
  const bones = (v: PartnerView): THREE.Object3D[] => {
    const { r, l } = (v as unknown as Inner).arms;
    return [r.upper, r.fore, r.hand, l.upper, l.fore, l.hand];
  };
  const pose = (v: PartnerView): THREE.Quaternion[] =>
    bones(v).map((b) => b.getWorldQuaternion(new THREE.Quaternion()));
  // (Normalised: the skeleton's quantised rotations are a hair off unit length, and angleTo
  // reads that as a ~1° turn.)
  const angle = (a: THREE.Quaternion[], b: THREE.Quaternion[]): number =>
    Math.max(...a.map((q, i) => q.clone().normalize().angleTo(b[i]!.clone().normalize())));

  it('the overlay at full weight depends only on the pose, not on the frames before it', () => {
    const swung = frozen();
    const still = frozen();
    // One partner chambers a slash over 20 frames (the knife target moves), the other rests.
    const ch = standing();
    for (let k = 0; k < 20; k++) {
      ch.arsenal.melee = {
        ...ch.arsenal.melee,
        phase: 'windup',
        move: 'slash',
        windupTotal: KNIFE.openingWindup,
        timer: KNIFE.openingWindup * (1 - k / 19),
      };
      step(swung, ch);
      step(still, standing());
    }
    step(swung, standing(), 5);
    step(still, standing(), 5);
    expect(angle(pose(swung), pose(still))).toBeLessThan(1e-4);
  });

  it('a partial-weight overlay blends with the clip the same way every frame', () => {
    // Prone: the partner's own overlay is off, so only this half-weight one moves the arm.
    const prone = standing();
    prone.move.prone = true;
    const v = frozen(prone);
    const { r } = (v as unknown as Inner).arms;
    const aim: ArmPose = { upper: [0.2, 0.6, -0.75], fore: [0.8, 0.2, 0.4] };
    const frame = (): THREE.Quaternion[] => {
      step(v, prone);
      poseArm(r, aim, 0, 0.5);
      return pose(v);
    };
    const first = frame();
    for (let i = 0; i < 5; i++) frame();
    expect(angle(frame(), first)).toBeLessThan(1e-4);
  });
});
