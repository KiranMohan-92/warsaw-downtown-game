/**
 * First-person arm rig. The arms are baked per gun (tools/assets/build_fparms.py: analytic
 * two-bone IK onto the grips) and ship without skin weights (the arms folder has no byte room);
 * arms.json carries the posed pivots instead — shoulder, elbow, wrist and middle knuckle per side,
 * in gun space. At load `skinArms` derives smooth weights from those pivots (joint bisector planes)
 * and `ArmRig` re-poses the arms every frame with the same analytic two-bone IK the builder used:
 * the wrist goes to a keyed target (render/fpAnims.ts), the elbow keeps its baked pole.
 * Six bones, one skinned draw, one program (compiled at warm-up like every other).
 */
import * as THREE from 'three';

export type Vec3 = [number, number, number];
/** [shoulder, elbow, wrist, middle knuckle] (gun space). */
export type ArmChain = [Vec3, Vec3, Vec3, Vec3];
export interface ArmPivots {
  L: ArmChain;
  R: ArmChain;
}
export type Side = 'L' | 'R';
/** Bone index per side: upper arm, forearm, hand. */
export const BONE = { L: [0, 1, 2], R: [3, 4, 5] } as const;

const v = (a: Vec3): THREE.Vector3 => new THREE.Vector3(a[0], a[1], a[2]);
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

/**
 * Per-vertex weights for one position: side (nearest chain unless `side` is given — the mesh's
 * connected piece decides, see `skinArms`), and upper/fore/hand weights along that chain.
 */
export function armWeights(
  p: THREE.Vector3,
  pivots: ArmPivots,
  forced?: Side,
): { side: Side; w: [number, number, number] } {
  let best: Side = forced ?? 'L';
  let bestD = Infinity;
  for (const side of forced ? [] : (['L', 'R'] as const)) {
    const [s, e, w, k] = pivots[side].map(v) as [
      THREE.Vector3,
      THREE.Vector3,
      THREE.Vector3,
      THREE.Vector3,
    ];
    // Fingers run past the knuckle: extend the hand segment.
    const tip = k.clone().addScaledVector(k.clone().sub(w), 0.9);
    const d = Math.min(segDist(p, s, e), segDist(p, e, w), segDist(p, w, tip));
    if (d < bestD) {
      bestD = d;
      best = side;
    }
  }
  const [s, e, w, k] = pivots[best].map(v) as [
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
    THREE.Vector3,
  ];
  const uu = e.clone().sub(s).normalize();
  const uf = w.clone().sub(e).normalize();
  const uh = k.clone().sub(w).normalize();
  // Signed distance past the elbow / wrist bisector planes, blended over a few cm (sleeve folds).
  const de = p.clone().sub(e).dot(uu.clone().add(uf).normalize());
  const dw = p.clone().sub(w).dot(uf.clone().add(uh).normalize());
  const a = smooth(-0.03, 0.03, de);
  const b = smooth(-0.02, 0.015, dw);
  return { side: best, w: [1 - a, a * (1 - b), a * b] };
}

/**
 * Which arm each vertex belongs to. The arms are cut above the elbows, so each arm (and each
 * forearm plate) is its own connected piece of the mesh (vertices welded by position across UV
 * seams); a piece goes to the side whose upper arm + forearm it lies nearest on average. Per-vertex
 * nearest-chain picks tear where the hands overlap (the pistol's two-hand grip).
 */
export function armSides(geometry: THREE.BufferGeometry, pivots: ArmPivots): Side[] {
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const weld = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    const j = weld.get(key);
    if (j === undefined) weld.set(key, i);
    else join(i, j);
  }
  const index = geometry.getIndex();
  if (index)
    for (let t = 0; t < index.count; t += 3) {
      join(index.getX(t), index.getX(t + 1));
      join(index.getX(t), index.getX(t + 2));
    }
  const chain = (side: Side): [THREE.Vector3, THREE.Vector3, THREE.Vector3] =>
    pivots[side].slice(0, 3).map(v) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  const [ls, le, lw] = chain('L');
  const [rs, re, rw] = chain('R');
  const score = new Map<number, number>(); // Σ (dL − dR): < 0 → left
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    const dl = Math.min(segDist(p, ls, le), segDist(p, le, lw));
    const dr = Math.min(segDist(p, rs, re), segDist(p, re, rw));
    const r = find(i);
    score.set(r, (score.get(r) ?? 0) + dl - dr);
  }
  return Array.from({ length: n }, (_, i) => ((score.get(find(i)) ?? 0) < 0 ? 'L' : 'R'));
}

/** Add skinIndex/skinWeight to the baked arms geometry (6 bones, see BONE). */
export function skinArms(geometry: THREE.BufferGeometry, pivots: ArmPivots): void {
  const pos = geometry.getAttribute('position');
  const n = pos.count;
  const idx = new Uint16Array(n * 4);
  const wts = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const sides = armSides(geometry, pivots);
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    const { side, w } = armWeights(p, pivots, sides[i]);
    const bones = BONE[side];
    for (let j = 0; j < 3; j++) {
      idx[i * 4 + j] = bones[j]!;
      wts[i * 4 + j] = w[j]!;
    }
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
}

/** Rotation taking frame (dir a, pole pa) onto (dir b, pole pb) — no twist flips. */
function frameRotation(
  a: THREE.Vector3,
  pa: THREE.Vector3,
  b: THREE.Vector3,
  pb: THREE.Vector3,
): THREE.Quaternion {
  const basis = (d: THREE.Vector3, p: THREE.Vector3): THREE.Matrix4 => {
    const x = d.clone().normalize();
    const y = p.clone().addScaledVector(x, -p.dot(x)).normalize();
    const z = x.clone().cross(y);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const m = basis(b, pb).multiply(basis(a, pa).transpose());
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export interface ArmSolve {
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
  /** World (gun-space) rotations of the upper arm, forearm and hand relative to the bind pose. */
  upper: THREE.Quaternion;
  fore: THREE.Quaternion;
  hand: THREE.Quaternion;
}

/**
 * Analytic two-bone IK (the builder's `pose_arm`): shoulder `s` (possibly moved), wrist target
 * `t` (clamped to reach), elbow on the bind pose's pole side; `hand` = the hand's turn relative
 * to the forearm (identity: the bind wrist angle, carried by the forearm).
 */
export function solveArm(
  chain: ArmChain,
  s: THREE.Vector3,
  t: THREE.Vector3,
  hand: THREE.Quaternion,
  abs = false,
): ArmSolve {
  const [s0, e0, w0] = [v(chain[0]), v(chain[1]), v(chain[2])];
  const l1 = e0.distanceTo(s0);
  const l2 = w0.distanceTo(e0);
  const toT = t.clone().sub(s);
  const dist = Math.min(Math.max(toT.length(), Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.999);
  const fwd = toT.lengthSq() > 1e-12 ? toT.normalize() : w0.clone().sub(s0).normalize();
  const wrist = s.clone().addScaledVector(fwd, dist);
  // Bind pole: the elbow's offset from the shoulder→wrist line.
  const f0 = w0.clone().sub(s0).normalize();
  const pole0 = e0.clone().sub(s0);
  pole0.addScaledVector(f0, -pole0.dot(f0)).normalize();
  // Carry the pole by the rotation of the shoulder→wrist line (keeps the elbow on its side).
  const turn = new THREE.Quaternion().setFromUnitVectors(f0, fwd);
  const pole = pole0.clone().applyQuaternion(turn);
  pole.addScaledVector(fwd, -pole.dot(fwd)).normalize();
  const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
  const elbow = s.clone().addScaledVector(fwd, a).addScaledVector(pole, h);
  const upper = frameRotation(e0.clone().sub(s0), pole0, elbow.clone().sub(s), pole);
  const fore = frameRotation(w0.clone().sub(e0), pole0, wrist.clone().sub(elbow), pole);
  // The hand rides on the forearm (a free hand stays in line with it) and turns by `hand` on top;
  // `abs`: `hand` is the hand's own rotation from its bind pose (it holds something rigidly).
  return { elbow, wrist, upper, fore, hand: abs ? hand.clone() : fore.clone().multiply(hand) };
}

/** Wrist target + hand rotation per side (gun space); null = the bind pose. */
export interface ArmTarget {
  wrist: THREE.Vector3;
  hand: THREE.Quaternion;
  /** `hand` is absolute (the hand's rotation from bind), not relative to the forearm. */
  abs?: boolean;
}
export interface ArmTargets {
  L: ArmTarget | null;
  R: ArmTarget | null;
  /** Shoulders' positions (gun space) when the gun moves against the body; default = bind. */
  shoulders?: { L: THREE.Vector3; R: THREE.Vector3 };
}

/** The six bones of one arms mesh and the pose applied to them. */
export class ArmRig {
  readonly bones: THREE.Bone[];
  readonly skeleton: THREE.Skeleton;
  constructor(
    readonly mesh: THREE.SkinnedMesh,
    readonly pivots: ArmPivots,
  ) {
    this.bones = Array.from({ length: 6 }, () => {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      return b;
    });
    for (const b of this.bones) mesh.add(b);
    // Bone matrices are the bind→posed deltas themselves (mesh space): identity inverses.
    this.skeleton = new THREE.Skeleton(
      this.bones,
      this.bones.map(() => new THREE.Matrix4()),
    );
    mesh.bind(this.skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
  }

  /** Put every bone back to the bind pose. */
  rest(): void {
    for (const b of this.bones) b.matrix.identity();
  }

  /** Collapse one arm to a point (not drawn: its triangles degenerate). */
  hide(side: Side): void {
    for (const i of BONE[side]) this.bones[i]!.matrix.makeScale(0, 0, 0);
  }

  /** Bone lengths per side: upper arm + forearm (the reach of a straight arm). */
  reach(side: Side): number {
    const [s, e, w] = this.pivots[side].map(v) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    return s.distanceTo(e) + e.distanceTo(w);
  }

  pose(targets: ArmTargets): void {
    for (const side of ['L', 'R'] as const) {
      const chain = this.pivots[side];
      const [iu, ifo, ih] = BONE[side];
      const tgt = targets[side];
      const s = targets.shoulders?.[side] ?? v(chain[0]);
      if (!tgt && !targets.shoulders) {
        this.bones[iu]!.matrix.identity();
        this.bones[ifo]!.matrix.identity();
        this.bones[ih]!.matrix.identity();
        continue;
      }
      const sol = solveArm(
        chain,
        s,
        tgt?.wrist ?? v(chain[2]),
        tgt?.hand ?? new THREE.Quaternion(),
        tgt?.abs ?? false,
      );
      const delta = (m: THREE.Matrix4, q: THREE.Quaternion, from: Vec3, to: THREE.Vector3) =>
        m.makeRotationFromQuaternion(q).setPosition(to.clone().sub(v(from).applyQuaternion(q)));
      delta(this.bones[iu]!.matrix, sol.upper, chain[0], s);
      delta(this.bones[ifo]!.matrix, sol.fore, chain[1], sol.elbow);
      delta(this.bones[ih]!.matrix, sol.hand, chain[2], sol.wrist);
    }
  }
}
