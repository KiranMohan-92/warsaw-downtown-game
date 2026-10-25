"""Build the third-person soldiers: Rocketbox avatars animated with Quaternius UAL clips.

    blender -b --python tools/assets/build_soldiers.py -- [--only m01]   # pose + retarget + GLB
    python tools/assets/build_soldiers.py                                # atlases + manifest

Blender stage, per avatar (Microsoft Rocketbox, MIT):
- apply the FBX's 0.01 scale / axis turn (armature space = world metres);
- pose both arms on the rifle with the first-person solver (build_fparms.pose_arm): the soldiers
  hold their guns exactly like the player's own arms, and the gun's pose relative to the right
  hand is recorded (the client mounts the rifle on that bone);
- retarget the UAL clips (Quaternius, CC0; T-pose, UE skeleton) onto the Biped skeleton by
  world-space rotation deltas against an *aligned* rest (each target bone turned so its direction
  matches the source rest bone: the A-pose/T-pose difference cancels), pelvis motion scaled by
  leg length; the arms keep the rifle pose in every locomotion clip;
- combat action clips (ACTIONS: reloads standing / kneeling / running / pistol, frag throw, knife
  strike, guard, hit flinches) from the Higgsfield clips (Meshy 24-joint humanoid, HF_BONES) and
  UAL, baked to the sim's durations and used by the client as upper-body layers; "grip" clips
  keep the rifle grip (the gun follows the source weapon hand, the support hand follows the
  source relative to it), the layer root is folded into model space;
- pack the four materials (body, head, helmet, equipment) into one 2×2 atlas (one draw call),
  drop the knife, export a GLB (skin + clips, no materials).
Package stage: build the atlases (ACU recoloured like the first-person arms: charcoal-olive
digital, dark gloves) as WebP (tools/assets/webp.py, as faithful as the old JPEG q88/q90),
soldiers.json and the shipped GLBs with the animation slimmed (`slim_animations`).

Raw inputs are git-ignored; a worktree reads the main checkout's with WD_RAW_ROOT=<checkout>.
"""

import json
import math
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import bpy
    from mathutils import Matrix, Quaternion, Vector
except ImportError:
    bpy = None

ROOT = HERE.parents[1]
# Git-ignored raw inputs (Rocketbox, UAL, Higgsfield clips) can live in another checkout (a worktree
# builds from the main checkout's tools/assets/raw): WD_RAW_ROOT=<that checkout>.
RAW = Path(os.environ.get('WD_RAW_ROOT', ROOT)) / 'tools/assets/raw'
RB = RAW / 'rocketbox/Assets/Avatars/Professions'
UAL = RAW / 'quaternius/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb'
HF_ANIMS = RAW / 'higgsfield/anims'
BUILD = ROOT / 'tools/assets/build/soldiers'
OUT = ROOT / 'packages/client/public/models/soldiers'
NL = '\n'

AVATARS = {
    'm01': ('Military_Male_01', 'sm002'),
    'm04': ('Military_Male_04', 'sm005'),
}

# UAL clip → our clip name.
CLIPS = {
    'Idle_Loop': 'idle',
    'Walk_Loop': 'walk',
    'Jog_Fwd_Loop': 'jog',
    'Sprint_Loop': 'sprint',
    'Crouch_Idle_Loop': 'crouchIdle',
    'Crouch_Fwd_Loop': 'crouchWalk',
    'Jump_Start': 'jumpStart',
    'Jump_Loop': 'fall',
    'Jump_Land': 'land',
    'Death01': 'death',
}

# Source (UAL) → target (Biped) bones that are retargeted; (source child, target child) give the
# bone direction for the rest alignment (None: the rests already agree, e.g. upright pelvis).
BONES = {
    'pelvis': ('Bip01 Pelvis', None),
    'spine_01': ('Bip01 Spine', ('spine_02', 'Bip01 Spine1')),
    'spine_02': ('Bip01 Spine1', ('spine_03', 'Bip01 Spine2')),
    'spine_03': ('Bip01 Spine2', ('neck_01', 'Bip01 Neck')),
    'neck_01': ('Bip01 Neck', ('Head', 'Bip01 Head')),
    'Head': ('Bip01 Head', None),
}
for s, t in (('l', 'L'), ('r', 'R')):
    BONES |= {
        f'thigh_{s}': (f'Bip01 {t} Thigh', (f'calf_{s}', f'Bip01 {t} Calf')),
        f'calf_{s}': (f'Bip01 {t} Calf', (f'foot_{s}', f'Bip01 {t} Foot')),
        f'foot_{s}': (f'Bip01 {t} Foot', (f'ball_{s}', f'Bip01 {t} Toe0')),
    }


# Arms: retargeted only in the death clip (every other clip keeps the rifle hold).
ARMS = {}
for s_, t_ in (('l', 'L'), ('r', 'R')):
    ARMS |= {
        f'clavicle_{s_}': (f'Bip01 {t_} Clavicle', (f'upperarm_{s_}', f'Bip01 {t_} UpperArm')),
        f'upperarm_{s_}': (f'Bip01 {t_} UpperArm', (f'lowerarm_{s_}', f'Bip01 {t_} Forearm')),
        f'lowerarm_{s_}': (f'Bip01 {t_} Forearm', (f'hand_{s_}', f'Bip01 {t_} Hand')),
        f'hand_{s_}': (f'Bip01 {t_} Hand', (f'middle_01_{s_}', f'Bip01 {t_} Finger2')),
    }

# Higgsfield clips (Higgsfield 3d_rigging on the Quaternius UAL mannequin; Meshy animation library):
# a 24-joint humanoid. Its spine is named top-down (Spine02 sits on the hips, Spine is the chest);
# the hands have no fingers, so the hand's own tail gives its direction ('<tail>').
HF_BONES = {
    'Hips': ('Bip01 Pelvis', None),
    'Spine02': ('Bip01 Spine', ('Spine01', 'Bip01 Spine1')),
    'Spine01': ('Bip01 Spine1', ('Spine', 'Bip01 Spine2')),
    'Spine': ('Bip01 Spine2', ('neck', 'Bip01 Neck')),
    'neck': ('Bip01 Neck', ('Head', 'Bip01 Head')),
    'Head': ('Bip01 Head', None),
}
HF_ARMS = {}
for s_, t_ in (('Left', 'L'), ('Right', 'R')):
    HF_BONES |= {
        f'{s_}UpLeg': (f'Bip01 {t_} Thigh', (f'{s_}Leg', f'Bip01 {t_} Calf')),
        f'{s_}Leg': (f'Bip01 {t_} Calf', (f'{s_}Foot', f'Bip01 {t_} Foot')),
        f'{s_}Foot': (f'Bip01 {t_} Foot', (f'{s_}ToeBase', f'Bip01 {t_} Toe0')),
    }
    HF_ARMS |= {
        f'{s_}Shoulder': (f'Bip01 {t_} Clavicle', (f'{s_}Arm', f'Bip01 {t_} UpperArm')),
        f'{s_}Arm': (f'Bip01 {t_} UpperArm', (f'{s_}ForeArm', f'Bip01 {t_} Forearm')),
        f'{s_}ForeArm': (f'Bip01 {t_} Forearm', (f'{s_}Hand', f'Bip01 {t_} Hand')),
        f'{s_}Hand': (f'Bip01 {t_} Hand', ('<tail>', f'Bip01 {t_} Finger2')),
    }
# Source rigs: bone maps and the chest / hand bones the grip retarget reads.
RIGS = {
    'ual': {'body': BONES, 'arms': ARMS, 'chest': 'spine_03', 'R': 'hand_r', 'L': 'hand_l'},
    'hf': {'body': HF_BONES, 'arms': HF_ARMS, 'chest': 'Spine', 'R': 'RightHand', 'L': 'LeftHand'},
}

# The sim's action timings (mirrors of packages/shared/src/config/tunables.ts; the client test
# render/soldierActions.test.ts fails when soldiers.json drifts from them). The client drives each
# action clip by the sim's progress, so a clip always ends when the sim's action does; baking it at
# the real duration keeps the native rate right for the reference weapon.
RELOAD_T = 2.1  # RIFLE.reloadTime (AR-7)
PISTOL_RELOAD_T = 1.5  # SIDEARM.reloadTime
THROW_T = (0.32, 0.35)  # GRENADE.windup (pin + arm back → release), GRENADE.recovery
STRIKE_T = (0.22, 0.3)  # KNIFE.openingWindup (chamber → impact), KNIFE.recovery
GUARD_T = 0.25  # KNIFE_DEFENSE.parryWindow: the guard is fully up when the parry window closes

# Combat action clips (upper-body layers over locomotion in the client). `mode`:
#   grip - the hands keep the rifle grip: the gun follows the source right hand's motion relative
#          to its chest (a delta from the `ref` frame, where the source holds its weapon), the
#          right arm is solved onto the moved gun with the first-person solver, and the left hand
#          follows the source left hand's motion relative to the right (mag out, charging handle);
#   free - the arms are retargeted like the body (the right hand throws / swings);
#   body - the arms keep the rifle hold (flinches).
# `window`: source frames used; `turn` (grip): how much of the source weapon's rotation the gun
# follows; `mark`: the release / impact frame (split timing: the frames
# before it fill the sim's wind-up, the rest its recovery); `stable`: STABLE scale (lower lets
# the chest move: the gun needn't stay on target during these).
ACTIONS = [
    {'name': 'reload', 'src': 'standing_reload_mq.glb', 'mode': 'grip', 'window': (13, 67), 'ref': 1,
     'stable': 0.6, 'turn': 0.6, 'time': RELOAD_T},
    {'name': 'reloadKneel', 'src': 'kneeling_reload.glb', 'mode': 'grip', 'window': (4, 150), 'ref': 1,
     'stable': 1.0, 'turn': 0.35, 'time': RELOAD_T},
    {'name': 'reloadRun', 'src': 'running_reload.glb', 'mode': 'grip', 'window': (16, 70), 'ref': 1,
     'stable': 0.8, 'turn': 0.55, 'time': RELOAD_T},
    {'name': 'reloadPistol', 'src': 'ual:Pistol_Reload', 'mode': 'grip', 'window': (0, 40), 'ref': 0,
     'stable': 0.6, 'turn': 0.7, 'time': PISTOL_RELOAD_T},
    {'name': 'throw', 'src': 'crouch_pull_throw.glb', 'mode': 'free', 'window': (60, 106), 'mark': 86,
     'stable': 0.35, 'time': THROW_T},
    {'name': 'strike', 'src': 'ual:Sword_Attack', 'mode': 'free', 'window': (3, 24), 'mark': 10,
     'stable': 0.35, 'time': STRIKE_T},
    {'name': 'guard', 'src': 'two_handed_parry.glb', 'mode': 'grip', 'window': (1, 7), 'ref': 1,
     'stable': 1.0, 'turn': 0.15, 'time': GUARD_T},
    {'name': 'hit', 'src': 'ual:Hit_Chest', 'mode': 'body', 'window': (0, 8), 'stable': 0.7, 'time': None},
    {'name': 'hitHead', 'src': 'ual:Hit_Head', 'mode': 'body', 'window': (0, 10), 'stable': 0.6,
     'time': None},
]


SRC_FPS = 24
"""`window`/`mark`/`ref` frames are at 24 fps (both sources' native rate). glTF imports turn seconds
into frames at the scene rate (the Rocketbox FBX sets 30), so they are rescaled to it."""


LEFT_MAX_Y = 0.08
"""Grip retarget: the left wrist stays at most this far above the bore (gun space, m)."""
LAYER_ROOT = 'Bip01 Spine1'
"""Action clips are upper-body layers rooted here (the client's `upperBones` and the package
stage's channel filter use the same bone)."""


def sample_frames(spec: dict, fps: int) -> tuple[list[float], float | None]:
    """Source frames (fractional, scene rate) for each output frame, and the clip time of the mark."""
    k = fps / SRC_FPS
    w0, w1 = (f * k for f in spec['window'])
    t = spec['time']
    if t is None:  # native speed
        n = max(1, round(w1 - w0))
        return [w0 + (w1 - w0) * i / n for i in range(n + 1)], None
    if isinstance(t, tuple):
        m = spec['mark'] * k
        nw, nr = max(1, round(t[0] * fps)), max(1, round(t[1] * fps))
        frames = [w0 + (m - w0) * k / nw for k in range(nw)] + [m + (w1 - m) * k / nr for k in range(nr + 1)]
        return frames, round(nw / fps, 4)
    n = max(1, round(t * fps))
    return [w0 + (w1 - w0) * k / n for k in range(n + 1)], None


def source_rest(src) -> dict:
    Ws = src.matrix_world
    rest = {b.name: (Ws @ b.matrix_local) for b in src.data.bones}
    for b in src.data.bones:  # '<tail>' directions (a hand without finger bones)
        rest[b.name + '<tail>'] = Matrix.Translation(Ws @ b.tail_local)
    return rest


def align_rest(maps: dict, srest: dict, trest: dict) -> dict:
    """Each target bone turned so its direction matches the source rest bone (A/T-pose cancel)."""
    aligned = {}
    for s, (t, d) in maps.items():
        R = trest[t].to_3x3().normalized()
        if d:
            child = s + '<tail>' if d[0] == '<tail>' else d[0]
            ds = srest[child].to_translation() - srest[s].to_translation()
            dt = trest[d[1]].to_translation() - trest[t].to_translation()
            R = dt.rotation_difference(ds).to_matrix() @ R
        aligned[t] = R
    return aligned


def retarget_frame(order, trest, srest, aligned, inv_map, spose, hold, leg, stable) -> dict:
    """One frame of the world-rotation-delta retarget: basis matrices per target bone."""
    P, out = {}, {}
    for b in order:
        n = b.name
        par = b.parent
        base = (P[par.name] @ trest[par.name].inverted() if par else Matrix.Identity(4)) @ trest[n]
        if n in inv_map:
            s = inv_map[n]
            Rs = spose[s].to_3x3().normalized()
            Rs0 = srest[s].to_3x3().normalized()
            R = Rs @ Rs0.inverted() @ aligned[n]
            # Aim-stable upper body: the chest, neck and head stay near upright so the rifle
            # points ahead in crouch/jog/sprint (the client adds aim pitch).
            if n in stable:
                R = R.to_quaternion().slerp(trest[n].to_quaternion(), stable[n]).to_matrix()
            M = R.to_4x4()
            if n == 'Bip01 Pelvis':
                delta = spose[s].to_translation() - srest[s].to_translation()
                M.translation = trest[n].to_translation() + delta * leg
            else:
                M.translation = base.to_translation()
            basis = base.inverted() @ M
        elif n in hold:
            basis = hold[n]
        else:
            basis = Matrix.Identity(4)
        P[n] = base @ basis
        out[n] = basis
    return out


def bake_actions(fp, rig, ctx, src, rig_kind, specs, actions) -> dict:
    """Bake combat action clips from one source armature (see ACTIONS). Poses are captured with
    the target's NLA muted (live evaluation for the grip solver), keyed after. Returns
    {clip: (duration, mark time or None)}."""
    arm = rig.arm
    ad = arm.animation_data
    for t in ad.nla_tracks:
        t.mute = True
    ad.action = None
    scene = bpy.context.scene
    fps = scene.render.fps
    maps = RIGS[rig_kind]
    trest, order, hold, arm_chain = ctx['trest'], ctx['order'], ctx['hold'], ctx['arm_chain']
    srest = source_rest(src)
    body_map = {t: s for s, (t, _) in maps['body'].items()}
    full_map = {t: s for s, (t, _) in (maps['body'] | maps['arms']).items()}
    aligned = align_rest(maps['body'] | maps['arms'], srest, trest)
    pel = maps['body'] and next(s for s, (t, _) in maps['body'].items() if t == 'Bip01 Pelvis')
    leg = trest['Bip01 Pelvis'].to_translation().z / srest[pel].to_translation().z
    Ws = src.matrix_world

    def arm_len(pos, names):
        return sum((pos(names[i + 1]) - pos(names[i])).length for i in range(2))

    k = arm_len(lambda n: trest[n].to_translation(), ['Bip01 R UpperArm', 'Bip01 R Forearm', 'Bip01 R Hand']) / (
        arm_len(lambda n: srest[n].to_translation(),
                [s for s, (t, _) in maps['arms'].items() if t in ('Bip01 R UpperArm', 'Bip01 R Forearm', 'Bip01 R Hand')])
    )
    spec_rifle = fp.POSES['rifle']
    G, hand, socket = ctx['G'], ctx['hand'], ctx['socket']
    G0 = G.to_3x3().normalized()
    # The gun rides on the bone the shoulders hang from (Biped: the neck, which STABLE keeps
    # near upright), so the hold keeps its reach whatever the chest does.
    anchor = arm.data.bones['Bip01 L Clavicle'].parent.name
    K0 = trest[anchor]
    Ks0 = srest[maps['chest']]

    def src_hands():
        """Source hands with the chest's motion undone (rest-chest axes)."""
        Ks = Ws @ src.pose.bones[maps['chest']].matrix
        Q = Ks0 @ Ks.inverted()
        return (Q @ (Ws @ src.pose.bones[maps['R']].matrix), Q @ (Ws @ src.pose.bones[maps['L']].matrix))

    out = {}
    for spec in specs:
        act = actions[spec['src']]
        src.animation_data.action = act
        frames, mark = sample_frames(spec, fps)
        inv_map = full_map if spec['mode'] == 'free' else body_map
        stable = {n: v * spec['stable'] for n, v in STABLE.items()}
        ref = None
        if spec['mode'] == 'grip':
            ref_f = spec['ref'] * fps / SRC_FPS
            scene.frame_set(int(math.floor(ref_f)), subframe=ref_f - math.floor(ref_f))
            ref = src_hands()
        poses = []
        for sf in frames:
            scene.frame_set(int(math.floor(sf)), subframe=sf - math.floor(sf))
            spose = {n: Ws @ src.pose.bones[n].matrix for n in inv_map.values()}
            basis = retarget_frame(order, trest, srest, aligned, inv_map, spose, hold, leg, stable)
            if spec['mode'] == 'grip':
                for n, M in basis.items():
                    arm.pose.bones[n].matrix_basis = Matrix.Identity(4) if n in arm_chain else M
                bpy.context.view_layer.update()
                HR, HL = src_hands()
                HR0, HL0 = ref
                drot = HR.to_3x3().normalized() @ HR0.to_3x3().normalized().inverted()
                dpos = (HR.to_translation() - HR0.to_translation()) * k
                rel = drot.inverted() @ (HL.to_translation() - HR.to_translation())
                dl = (rel - (HL0.to_translation() - HR0.to_translation())) * k
                drl = (drot.inverted() @ HL.to_3x3().normalized()) @ HL0.to_3x3().normalized().inverted()
                # The gun turns only `turn` of the source weapon's turn (the Meshy reloads tip
                # it far over; the left hand still follows the source relative to the gun).
                gturn = Quaternion().slerp(drot.to_quaternion(), spec.get('turn', 1.0)).to_matrix()
                Ht = Matrix.Translation(hand.to_translation() + dpos) @ (gturn @ hand.to_3x3().normalized()).to_4x4()
                X = arm.pose.bones[anchor].matrix @ K0.inverted()
                Gw = X @ Ht @ socket

                def to_world(p, point=False, Gw=Gw):
                    return Gw @ Vector(p) if point else Gw.to_3x3() @ Vector(p)

                M = G0.inverted() @ drl @ G0
                left = dict(spec_rifle['L'])
                w = Vector(left['w']) + G0.inverted() @ dl
                # The source has no gun: never above ours (a charging-handle slap reads as a wave).
                w.y = min(w.y, LEFT_MAX_Y)
                left['w'] = tuple(w)
                left['d'] = tuple(M @ Vector(left['d']))
                left['l'] = tuple(M @ Vector(left['l']))
                fp.pose_arm(rig, 'R', spec_rifle['R'], to_world)
                fp.pose_arm(rig, 'L', left, to_world)
                for n in arm_chain:
                    basis[n] = arm.pose.bones[n].matrix_basis.copy()
            # Layer root in model space: fold the source's pelvis/spine into Spine1 (as if its
            # parents were at rest). The client sets the chest from this relative to the model,
            # whatever the legs underneath are doing (a kneeling reload over the crouch clip).
            P = {}
            for b in order:
                par = b.parent
                P[b.name] = (P[par.name] @ trest[par.name].inverted() if par else Matrix.Identity(4)) @ trest[
                    b.name] @ basis[b.name]
            R = trest[LAYER_ROOT].to_3x3().normalized().inverted() @ P[LAYER_ROOT].to_3x3().normalized()
            root = R.to_4x4()
            root.translation = basis[LAYER_ROOT].to_translation()
            basis[LAYER_ROOT] = root
            poses.append({n: M for n, M in basis.items() if n in inv_map or n in hold})
        rig.reset()
        name = spec['name']
        a = bpy.data.actions.new(name)
        ad.action = a
        for f, bs in enumerate(poses):
            for n, M in bs.items():
                pb = arm.pose.bones[n]
                loc, rot, _ = M.decompose()
                pb.rotation_quaternion = rot
                pb.keyframe_insert('rotation_quaternion', frame=f)
                if n == 'Bip01 Pelvis':
                    pb.location = loc
                    pb.keyframe_insert('location', frame=f)
        ad.action = None
        track = ad.nla_tracks.new()
        track.name = name
        track.mute = True
        track.strips.new(name, 0, a)
        out[name] = (round((len(poses) - 1) / fps, 4), mark)
    for t in ad.nla_tracks:
        t.mute = False
    rig.reset()
    return out


PRONE_EYE = 0.36
"""Prone eye height in model units (the game's 0.35 m at the ~0.975 scale)."""
PRONE_EYE_FWD = 0.1
"""The eye sits this far ahead of the capsule (the head hit sphere is just ahead of it)."""


def build_prone(fp, rig, spec, fps):
    """Procedural prone clips (UAL has none): 'prone' (still) and 'proneCrawl' (a leg cycle).
    The body is tipped face-down from the pelvis, the spine/neck/head extend ~90° so the chest
    lifts and the eyes look ahead, the whole body is placed so the eye sits over the capsule at
    PRONE_EYE with the body lying behind (+Y: the model faces -Y) along the hit volumes, then the
    arms are re-aimed on the rifle with the first-person solver around that eye. Poses are
    captured first and keyed after (with the NLA muted), so no evaluation can overwrite them."""
    arm = rig.arm
    ad = arm.animation_data
    for t in ad.nla_tracks:
        t.mute = True
    ad.action = None
    Rx = lambda deg: Matrix.Rotation(math.radians(deg), 3, 'X')  # noqa: E731
    Rz = lambda deg: Matrix.Rotation(math.radians(deg), 3, 'Z')  # noqa: E731
    Ry = lambda deg: Matrix.Rotation(math.radians(deg), 3, 'Y')  # noqa: E731
    prone_spec = dict(spec, yaw=0)  # along the body: the hit volumes lie on the facing axis
    sight_y, ads_z = prone_spec['eye']
    eye_g = Vector((0, sight_y, ads_z / fp.VM_SCALE))

    def translate(bone, delta):
        pb = arm.pose.bones[bone]
        W = rig.W
        pb.matrix = W.inverted() @ Matrix.Translation(delta) @ W @ pb.matrix
        bpy.context.view_layer.update()

    def pose(phase):
        rig.reset()
        pel = rig.head('Bip01 Pelvis')
        rig.rotate('Bip01 Pelvis', Rx(90), pel)  # face down, head toward -Y
        for bone, deg in (
            ('Bip01 Spine1', -16),
            ('Bip01 Spine2', -18),
            ('Bip01 Neck', -26),
            ('Bip01 Head', -30),
        ):
            rig.rotate(bone, Rx(deg), rig.head(bone))
        # Legs a little apart, toes turned down onto the ground; the crawl draws one knee up
        # sideways, then the other.
        s = math.sin(phase * 2 * math.pi)
        for side, sx in (('L', 1), ('R', -1)):
            hip = rig.head(f'Bip01 {side} Thigh')
            lift = max(0.0, s * sx) * 38
            rig.rotate(f'Bip01 {side} Thigh', Ry(-sx * (8 + lift)), hip)
            knee = rig.head(f'Bip01 {side} Calf')
            rig.rotate(f'Bip01 {side} Calf', Ry(sx * lift * 1.2), knee)
            ankle = rig.head(f'Bip01 {side} Foot')
            rig.rotate(f'Bip01 {side} Foot', Rx(-55), ankle)
        # Place: the eye over the capsule, PRONE_EYE_FWD ahead, at PRONE_EYE.
        eye = rig.head('Bip01 Head') + Vector((0, -0.095, 0.075))
        target = Vector((0, -PRONE_EYE_FWD, PRONE_EYE))
        translate('Bip01 Pelvis', target - eye)
        rig.eye = rig.head('Bip01 Head') + Vector((0, -0.095, 0.075))

        def to_world(p, point=False):
            v = fp.gun_to_body(Vector(p) - eye_g if point else Vector(p))
            return rig.eye + v if point else v

        for side in 'RL':
            fp.pose_arm(rig, side, prone_spec[side], to_world)
        return {pb.name: pb.matrix_basis.copy() for pb in arm.pose.bones}

    frames = {'prone': [pose(0.0)], 'proneCrawl': [pose(i / 24) for i in range(25)]}
    rig.reset()
    out = {}
    for name, poses in frames.items():
        act = bpy.data.actions.new(name)
        ad.action = act
        for f, basis in enumerate(poses):
            for n, M in basis.items():
                pb = arm.pose.bones[n]
                loc, rot, _ = M.decompose()
                pb.rotation_quaternion = rot
                pb.keyframe_insert('rotation_quaternion', frame=f)
                if n == 'Bip01 Pelvis':
                    pb.location = loc
                    pb.keyframe_insert('location', frame=f)
        if len(poses) == 1:  # a still pose needs two keys to be a clip
            for n, M in poses[0].items():
                arm.pose.bones[n].keyframe_insert('rotation_quaternion', frame=1)
            arm.pose.bones['Bip01 Pelvis'].keyframe_insert('location', frame=1)
        ad.action = None
        track = ad.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        out[name] = round(max(1, len(poses) - 1) / fps, 4)
    for t in ad.nla_tracks:
        t.mute = False
    rig.reset()
    return out


STABLE = {'Bip01 Spine2': 0.85, 'Bip01 Neck': 0.85, 'Bip01 Head': 0.85}
"""Upper-body bones blended toward their upright rest (world rotation), per clip except death."""


def blender_stage() -> None:
    import build_fparms as fp  # noqa: PLC0415

    argv = sys.argv[sys.argv.index('--') + 1 :] if '--' in sys.argv else []
    only = argv[argv.index('--only') + 1].split(',') if '--only' in argv else list(AVATARS)
    BUILD.mkdir(parents=True, exist_ok=True)
    for aid in only:
        folder, prefix = AVATARS[aid]
        info = build_avatar(fp, aid, RB / folder / 'Export' / f'{folder}.fbx', prefix)
        (BUILD / f'{aid}.json').write_text(json.dumps(info))
        print(aid, {k: v for k, v in info.items() if k not in ('glove', 'socket')})


def apply_transforms(objs) -> None:
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    # Location too: the FBX armature object sits at pelvis height (armature space must be world).
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def hierarchy(arm) -> list:
    out, todo = [], [b for b in arm.data.bones if b.parent is None]
    while todo:
        b = todo.pop(0)
        out.append(b)
        todo.extend(b.children)
    return out


def build_avatar(fp, aid: str, fbx: Path, prefix: str) -> dict:
    rig = fp.Rig(fbx)
    arm, mesh = rig.arm, rig.mesh
    for o in [o for o in bpy.data.objects if o not in (arm, mesh)]:
        bpy.data.objects.remove(o)
    # The FBX take keys the armature object's 0.01 scale: any re-evaluation would undo the apply.
    for o in (arm, mesh):
        o.animation_data_clear()
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    apply_transforms([arm, mesh])
    rig.W = arm.matrix_world.copy()
    rig.eye = rig.head('Bip01 Head') + Vector((0, -0.095, 0.075))

    # --- Rifle hold (the first-person pose, around this avatar's own eye). ---
    spec = fp.POSES['rifle']
    sight_y, ads_z = spec['eye']
    eye_g = Vector((0, sight_y, ads_z / fp.VM_SCALE))
    yaw = Matrix.Rotation(math.radians(spec['yaw']), 3, 'Z')

    def to_world(p, point=False):
        v = yaw @ fp.gun_to_body(Vector(p) - eye_g if point else Vector(p))
        return rig.eye + v if point else v

    rig.reset()
    for side in 'RL':
        fp.pose_arm(rig, side, spec[side], to_world)
    arm_chain = set()
    for side in 'LR':
        todo = [arm.data.bones[f'Bip01 {side} Clavicle']]
        while todo:
            b = todo.pop()
            arm_chain.add(b.name)
            todo.extend(b.children)
    hold = {n: arm.pose.bones[n].matrix_basis.copy() for n in arm_chain}
    # Gun group (gun space → world) relative to the right hand, in armature space.
    G = Matrix.Identity(4)
    for c, axis in enumerate(((1, 0, 0), (0, 1, 0), (0, 0, 1))):
        G.col[c][:3] = to_world(axis)
    G.col[3][:3] = to_world((0, 0, 0), point=True)
    hand = arm.pose.bones['Bip01 R Hand'].matrix.copy()
    socket = hand.inverted() @ G
    # Gun markers: bones under the right hand that land on the gun's origin / +forward / +up
    # under the hold pose (the client builds the gun frame from their world positions, so no
    # bone-axis convention can bite). Edit bones live in rest space: p_rest = Hr · Hp⁻¹ · p.
    Hr = arm.data.bones['Bip01 R Hand'].matrix_local.copy()
    marks = {
        'gun_o': to_world((0, 0, 0), point=True),
        'gun_f': to_world((0, 0, -0.2), point=True),
        'gun_u': to_world((0, 0.1, 0), point=True),
    }
    rig.reset()
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb_hand = arm.data.edit_bones['Bip01 R Hand']
    for name, p in marks.items():
        q = Hr @ hand.inverted() @ p
        eb = arm.data.edit_bones.new(name)
        eb.head = q
        eb.tail = q + Vector((0, 0, 0.02))
        eb.parent = eb_hand
        eb.use_connect = False
        eb.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')

    # --- Retarget. ---
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(UAL))
    src_objs = [o for o in bpy.data.objects if o not in before]
    src = next(o for o in src_objs if o.type == 'ARMATURE')
    ual_srcs = set(CLIPS) | {s['src'][4:] for s in ACTIONS if s['src'].startswith('ual:')}
    ual_actions = {a.name: a for a in bpy.data.actions if a.name in ual_srcs or a.name == 'A_TPose'}
    Ws = src.matrix_world
    srest = source_rest(src)
    trest = {b.name: b.matrix_local.copy() for b in arm.data.bones}
    # The grip retarget mixes armature-space bone matrices with world points.
    assert all(abs(arm.matrix_world[r][c] - (r == c)) < 1e-6 for r in range(4) for c in range(4)), (
        'armature space must be world (transforms applied)'
    )
    aligned = align_rest(BONES | ARMS, srest, trest)
    body_map = {t: s for s, (t, _) in BONES.items()}
    death_map = {t: s for s, (t, _) in (BONES | ARMS).items()}
    leg = trest['Bip01 Pelvis'].to_translation().z / srest['pelvis'].to_translation().z
    order = hierarchy(arm)
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    arm.animation_data_create()
    src.animation_data_create()
    fps = bpy.context.scene.render.fps
    clips = {}
    for ual, name in CLIPS.items():
        act = ual_actions[ual]
        src.animation_data.action = act
        f0, f1 = (int(round(v)) for v in act.frame_range)
        inv_map = death_map if name == 'death' else body_map
        out = bpy.data.actions.new(name)
        arm.animation_data.action = out
        stable = {} if name == 'death' else STABLE
        for f in range(f0, f1 + 1):
            bpy.context.scene.frame_set(f)
            spose = {n: Ws @ src.pose.bones[n].matrix for n in inv_map.values()}
            basis = retarget_frame(order, trest, srest, aligned, inv_map, spose, hold, leg, stable)
            for n, M in basis.items():
                pb = arm.pose.bones[n]
                if n in inv_map or n in hold:
                    loc, rot, _ = M.decompose()
                    pb.rotation_quaternion = rot
                    pb.keyframe_insert('rotation_quaternion', frame=f - f0)
                    if n == 'Bip01 Pelvis':
                        pb.location = loc
                        pb.keyframe_insert('location', frame=f - f0)
        clips[name] = round((f1 - f0) / fps, 4)
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, out)
        arm.animation_data.action = None
    # --- Combat actions (reloads, throw, knife strike, guard, flinches). ---
    ctx = {'trest': trest, 'order': order, 'hold': hold, 'arm_chain': arm_chain, 'G': G, 'hand': hand,
           'socket': socket}
    marks = {}

    def add_actions(results):
        for n, (dur, mark) in results.items():
            clips[n] = dur
            if mark is not None:
                marks[n] = mark

    add_actions(bake_actions(fp, rig, ctx, src, 'ual', [s for s in ACTIONS if s['src'].startswith('ual:')],
                             {s['src']: ual_actions[s['src'][4:]] for s in ACTIONS if s['src'].startswith('ual:')}))
    for o in src_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for hf_spec in [s for s in ACTIONS if not s['src'].startswith('ual:')]:
        before = set(bpy.data.objects)
        acts_before = set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=str(HF_ANIMS / hf_spec['src']))
        hf_objs = [o for o in bpy.data.objects if o not in before]
        hf = next(o for o in hf_objs if o.type == 'ARMATURE')
        hf.animation_data_create()
        hf_act = next(a for a in bpy.data.actions if a not in acts_before)
        add_actions(bake_actions(fp, rig, ctx, hf, 'hf', [hf_spec], {hf_spec['src']: hf_act}))
        for o in hf_objs:
            bpy.data.objects.remove(o, do_unlink=True)
        for a in [a for a in bpy.data.actions if a not in acts_before and a.name != hf_spec['name']]:
            bpy.data.actions.remove(a)
    standing_eye = rig.eye.copy()
    clips |= build_prone(fp, rig, spec, fps)
    rig.eye = standing_eye  # the scale reference (the prone builder moves the eye)
    for a in list(bpy.data.actions):
        if a.name not in CLIPS.values() and a.name not in ('prone', 'proneCrawl', *(x['name'] for x in ACTIONS)):
            bpy.data.actions.remove(a)
    rig.reset()

    # --- One material: 2×2 atlas (body, head / helmet, equipment), knife dropped. ---
    me = mesh.data
    names = [m.name.removeprefix(prefix + '_') for m in me.materials]
    quad = {'body': (0.0, 0.0), 'head': (0.5, 0.0), 'helmet': (0.0, 0.5), 'equipment': (0.5, 0.5)}
    import bmesh  # noqa: PLC0415

    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.active
    knife = [f for f in bm.faces if names[f.material_index] not in quad]
    bmesh.ops.delete(bm, geom=knife, context='FACES')
    groups = {g.index: g.name for g in mesh.vertex_groups}
    dl = bm.verts.layers.deform.active
    glove = []
    for f in bm.faces:
        part = names[f.material_index]
        ou, ov = quad[part]
        for loop in f.loops:
            u, v = loop[uv].uv
            loop[uv].uv = (ou + u / 2, ov + v / 2)
        f.material_index = 0
        if part == 'body' and any(
            sum(w for g, w in vert[dl].items() if ' Hand' in groups[g] or ' Finger' in groups[g]) > 0.5
            for vert in f.verts
        ):
            glove.append([tuple(loop[uv].uv) for loop in f.loops])
    bm.to_mesh(me)
    bm.free()
    while len(me.materials) > 1:
        me.materials.pop()

    height = max((mesh.matrix_world @ v.co).z for v in me.vertices)
    gear = add_gear(rig, mesh)
    path = BUILD / f'{aid}.glb'
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    mesh.select_set(True)
    gear.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format='GLB',
        use_selection=True,
        export_materials='NONE',
        export_animations=True,
        export_animation_mode='ACTIONS',
        export_force_sampling=True,
        export_skins=True,
        export_morph=False,
        export_yup=True,
    )
    return {
        'eye': round(rig.eye.z, 4),
        'height': round(height, 4),
        'aimYaw': round(math.radians(spec['yaw']), 5),
        'socket': [round(socket[r][c], 6) for r in range(4) for c in range(4)],
        'clips': clips,
        'marks': marks,
        'tris': sum(len(p.vertices) - 2 for p in me.polygons),
        'prefix': prefix,
        'folder': AVATARS[aid][0],
        'glove': glove,
    }


# Real insignia on the ACU body texture (flag, rank, unit shield, name tapes), as normalised
# rects (x0, y0, x1, y1) with the offset (dx, dy) of a clean patch of the same garment to copy
# over them. Generous: they cover all three avatars' layouts.
SCRUB = [
    ((0.12, 0.51, 0.225, 0.65), (0.0, 0.14)),  # left sleeve: flag + rank
    ((0.775, 0.51, 0.88, 0.65), (0.0, 0.14)),  # right sleeve: rank + unit shield
    ((0.46, 0.32, 0.535, 0.39), (-0.08, 0.0)),  # vest name tape
    ((0.085, 0.245, 0.205, 0.295), (0.0, 0.06)),  # chest tape (left panel)
    ((0.795, 0.245, 0.905, 0.295), (0.0, 0.06)),  # chest tape (right panel)
]


def scrub(im):
    """Paint the real insignia out with nearby camo (colour and normal maps alike)."""
    W, H = im.size
    im = im.copy()
    for (x0, y0, x1, y1), (dx, dy) in SCRUB:
        box = (int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H))
        src = (box[0] + int(dx * W), box[1] + int(dy * H), box[2] + int(dx * W), box[3] + int(dy * H))
        im.paste(im.crop(src), box[:2])
    return im


# Gear atlas regions (UV, v up; image rows run the other way): mask = left top quarter,
# visor = left, below it, shell (pack / pouch / antenna) = right half.
MASK_UV = (0.0, 0.5, 0.5, 1.0)
VISOR_UV = (0.0, 0.25, 0.5, 0.5)
SHELL_UV = (0.5, 0.0, 1.0, 1.0)
ARMOR_UV = (0.0, 0.0, 0.5, 0.25)


def add_gear(rig, mesh):
    """Near-future kit, one mesh 'gear' rigidly skinned (head / chest / thigh), UVs into the shared
    gear atlas: a hard-shell half mask and a curved visor (smoothed offset shells of this avatar's
    own face, so they fit), a rounded hard-shell tech pack with power module and antenna, and a
    hard case on the right thigh."""
    import bmesh  # noqa: PLC0415

    # Rest-pose bone heads: the armature now evaluates its NLA clips, but the body vertices we fit
    # against are in the rest pose.
    def rest(name):
        return rig.arm.data.bones[name].head_local.copy()

    head = rest('Bip01 Head')
    eye = rig.eye
    me = mesh.data
    hb = mesh.vertex_groups['Bip01 Head'].index

    bm = bmesh.new()
    dl = bm.verts.layers.deform.verify()
    uvl = bm.loops.layers.uv.verify()

    def weigh(verts, bone):
        gi = mesh.vertex_groups[bone].index
        for v in verts:
            v[dl].clear()
            v[dl][gi] = 1.0

    def planar(faces, verts, region):
        xs = [v.co.x for v in verts]
        zs = [v.co.z for v in verts]
        x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
        u0, v0, u1, v1 = region
        for f in faces:
            for loop in f.loops:
                c = loop.vert.co
                loop[uvl].uv = (
                    u0 + (c.x - x0) / (x1 - x0) * (u1 - u0),
                    v0 + (c.z - z0) / (z1 - z0) * (v1 - v0),
                )

    # The head's front surface, for ray-fitting the shells.
    from mathutils.bvhtree import BVHTree  # noqa: PLC0415

    src = bmesh.new()
    src.from_mesh(me)
    sdl = src.verts.layers.deform.active
    bmesh.ops.delete(
        src,
        geom=[f for f in src.faces if not all(sdl and v[sdl].get(hb, 0) > 0.5 for v in f.verts)],
        context='FACES',
    )
    tree = BVHTree.FromBMesh(src)
    src.free()

    def face_shell(z_bot, z_top, half_angle, lift, thick, region, cols=28, rows=10, smooth=3):
        """A clean grid shell over the face: rays from around the head find the surface, each
        vertex sits `lift` outside it (regular edges, a UV grid for the texture)."""
        grid = []
        for r in range(rows + 1):
            z = z_bot + (z_top - z_bot) * r / rows
            row = []
            for k in range(cols + 1):
                th = math.radians(-half_angle + 2 * half_angle * k / cols)
                d = Vector((math.sin(th), -math.cos(th), 0))  # the model faces -Y
                o = Vector((0, head.y, z))
                hit = tree.ray_cast(o + d * 0.3, -d, 0.3)[0]
                p = (hit if hit is not None else o + d * 0.1) + d * lift
                row.append(p)
            grid.append(row)
        # Light smoothing across columns (keeps the lip/nose shape out of the shell).
        for _ in range(smooth):
            grid = [
                [row[0]] + [(row[k - 1] + row[k] * 2 + row[k + 1]) / 4 for k in range(1, cols)] + [row[-1]]
                for row in grid
            ]
            grid = [grid[0]] + [
                [(grid[r - 1][k] + grid[r][k] * 2 + grid[r + 1][k]) / 4 for k in range(cols + 1)]
                for r in range(1, rows)
            ] + [grid[-1]]
        before_f = set(bm.faces)
        vs = [[bm.verts.new(p) for p in row] for row in grid]
        u0, v0, u1, v1 = region
        for r in range(rows):
            for k in range(cols):
                f = bm.faces.new([vs[r][k], vs[r][k + 1], vs[r + 1][k + 1], vs[r + 1][k]])
                for loop in f.loops:
                    rr = next(i for i, row in enumerate(vs) if loop.vert in row)
                    kk = vs[rr].index(loop.vert)
                    loop[uvl].uv = (u0 + (u1 - u0) * kk / cols, v0 + (v1 - v0) * rr / rows)
        new_f = [f for f in bm.faces if f not in before_f]
        bmesh.ops.solidify(bm, geom=new_f, thickness=thick)
        made_f = [f for f in bm.faces if f not in before_f]
        weigh(list({v for f in made_f for v in f.verts}), 'Bip01 Head')
        return len(made_f)

    n_mask = face_shell(eye.z - 0.15, eye.z - 0.026, 72, 0.014, 0.006, MASK_UV)
    n_visor = face_shell(eye.z - 0.034, eye.z + 0.03, 80, 0.013, 0.003, VISOR_UV, smooth=1)

    body = [mesh.matrix_world @ v.co for v in me.vertices]
    chest = rest('Bip01 Spine2')
    back_y = max(p.y for p in body if abs(p.z - (chest.z + 0.02)) < 0.12 and abs(p.x) < 0.14)
    thigh = rest('Bip01 R Thigh')
    calf = rest('Bip01 R Calf')
    leg_z = thigh.z * 0.45 + calf.z * 0.55
    leg_x = min(p.x for p in body if abs(p.z - leg_z) < 0.05 and p.x < 0)  # right = -X

    def box(center, size, bevel, segments=4):
        made = bmesh.ops.create_cube(bm, size=1.0)['verts']
        for v in made:
            v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2])) + center
        fs = list({f for v in made for f in v.link_faces})
        bmesh.ops.bevel(
            bm,
            geom=list({e for f in fs for e in f.edges}),
            offset=bevel,
            segments=segments,
            affect='EDGES',
            profile=0.5,
        )

    before = set(bm.faces)
    c = Vector((0, back_y + 0.08, chest.z - 0.03))
    box(c, (0.31, 0.15, 0.4), 0.055)  # main shell
    box(c + Vector((0, 0.02, 0.23)), (0.24, 0.11, 0.07), 0.03)  # comms module
    box(c + Vector((0, 0.09, -0.06)), (0.2, 0.035, 0.22), 0.015)  # power cell
    for sx in (-1, 1):
        box(c + Vector((sx * 0.185, -0.005, -0.05)), (0.06, 0.1, 0.24), 0.028)  # side canisters
    box(c + Vector((0.11, 0.03, 0.4)), (0.008, 0.008, 0.28), 0.003, 1)  # antenna
    pack_f = [f for f in bm.faces if f not in before]
    weigh(list({v for f in pack_f for v in f.verts}), 'Bip01 Spine2')
    before = set(bm.faces)
    pc = Vector((leg_x - 0.032, (thigh.y + calf.y) / 2, leg_z))
    box(pc, (0.055, 0.13, 0.16), 0.02)
    pouch_f = [f for f in bm.faces if f not in before]
    weigh(list({v for f in pouch_f for v in f.verts}), 'Bip01 R Thigh')
    # Shell UVs: box projection at a fixed density (0.62 m per half tile), wrapped.
    u0, v0, u1, v1 = SHELL_UV
    span = 0.62
    for f in pack_f + pouch_f:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for loop in f.loops:
            d = loop.vert.co - c
            loop[uvl].uv = (
                u0 + (0.5 + d[a] / span) % 1.0 * (u1 - u0),
                v0 + (0.5 + d[b] / span) % 1.0 * (v1 - v0),
            )
    # --- Armour plates: ray-fitted around each limb (rest A-pose; left = +X, forward = -Y). ---
    full = bmesh.new()
    full.from_mesh(me)
    body_tree = BVHTree.FromBMesh(full)
    full.free()

    def limb_shell(bone_a, bone_b, t0, t1, out, half, lift, weight, cols=14, rows=8, thick=0.006):
        a = rest(bone_a)
        b = rest(bone_b)
        axis = (b - a).normalized()
        length = (b - a).length
        out = Vector(out)
        out = (out - axis * out.dot(axis)).normalized()
        side = axis.cross(out)
        grid = []
        for r in range(rows + 1):
            ctr = a + axis * length * (t0 + (t1 - t0) * r / rows)
            row = []
            for k in range(cols + 1):
                th = math.radians(-half + 2 * half * k / cols)
                d = out * math.cos(th) + side * math.sin(th)
                hit = body_tree.ray_cast(ctr + d * 0.3, -d, 0.3)[0]
                row.append((hit if hit is not None else ctr + d * 0.07) + d * lift)
            grid.append(row)
        for _ in range(2):
            grid = [grid[0]] + [
                [(grid[r - 1][k] + grid[r][k] * 2 + grid[r + 1][k]) / 4 for k in range(cols + 1)]
                for r in range(1, rows)
            ] + [grid[-1]]
            grid = [
                [row[0]] + [(row[k - 1] + row[k] * 2 + row[k + 1]) / 4 for k in range(1, cols)] + [row[-1]]
                for row in grid
            ]
        before_f = set(bm.faces)
        vs = [[bm.verts.new(p) for p in row] for row in grid]
        u0, v0, u1, v1 = ARMOR_UV
        for r in range(rows):
            for k in range(cols):
                f = bm.faces.new([vs[r][k], vs[r][k + 1], vs[r + 1][k + 1], vs[r + 1][k]])
                for loop, (rr, kk) in zip(f.loops, ((r, k), (r, k + 1), (r + 1, k + 1), (r + 1, k))):
                    loop[uvl].uv = (u0 + (u1 - u0) * kk / cols, v0 + (v1 - v0) * rr / rows)
        new_f = [f for f in bm.faces if f not in before_f]
        bmesh.ops.solidify(bm, geom=new_f, thickness=thick)
        made = [f for f in bm.faces if f not in before_f]
        weigh(list({v for f in made for v in f.verts}), weight)
        return len(made)

    from build_fparms import FOREARM_GUARD as fg  # noqa: PLC0415 — shared with the first-person arms

    n_armor = 0
    for side_, sx in (('L', 1), ('R', -1)):
        B = f'Bip01 {side_} '
        n_armor += limb_shell(B + 'UpperArm', B + 'Forearm', -0.06, 0.4, (sx, 0, 0.7), 95, 0.02, B + 'UpperArm')
        n_armor += limb_shell(B + 'Forearm', B + 'Hand', *fg['t'], (sx, *fg['out']), fg['half'], fg['lift'],
                              B + 'Forearm', cols=fg['cols'], rows=fg['rows'], thick=fg['thick'])
        n_armor += limb_shell(B + 'Thigh', B + 'Calf', 0.12, 0.55, (sx * 0.3, -1, 0), 58, 0.016, B + 'Thigh')
        n_armor += limb_shell(B + 'Calf', B + 'Foot', 0.1, 0.72, (0, -1, 0), 62, 0.014, B + 'Calf')
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    gme = bpy.data.meshes.new('gear')
    bm.to_mesh(gme)
    bm.free()
    obj = bpy.data.objects.new('gear', gme)
    bpy.context.scene.collection.objects.link(obj)
    # bmesh deform layers index groups by position: same order as the body's groups.
    for g in mesh.vertex_groups:
        obj.vertex_groups.new(name=g.name)
    obj.parent = rig.arm
    obj.modifiers.new('Armature', 'ARMATURE').object = rig.arm
    print('gear: mask', n_mask, 'visor', n_visor, 'armor', n_armor, 'faces; total', len(gme.polygons))
    return obj


def balaclava(im, normal=False):
    """Knit balaclava over all the head skin (the face unwrap's upper blob)."""
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    a = np.asarray(im).astype(np.float32)
    H, W = a.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W]
    fy, fx = yy / H, xx / W
    skin = (a.max(axis=2) > 18) & (fy < 0.68)
    eyes = ((fx - 0.5) / 0.15) ** 2 + ((fy - 0.285) / 0.048) ** 2
    open_ = np.ones_like(eyes)  # the visor covers the eyes: no opening, no skin anywhere
    k = skin * open_
    rng = np.random.default_rng(7)
    rib = 0.5 + 0.5 * np.sin(fx * W * np.pi / 3.0)  # vertical knit ribs, 6 px pitch
    grain = rng.random((H, W)).astype(np.float32)
    if normal:
        nx = (np.cos(fx * W * np.pi / 3.0) * 0.35 + (grain - 0.5) * 0.2) * 127 + 128
        fab = np.stack([nx, np.full_like(nx, 128), np.full_like(nx, 245)], axis=2)
    else:
        lum = a.mean(axis=2, keepdims=True) / 255
        shade = 0.55 + 0.9 * lum  # keep the face's form (nose, brow) faintly
        base = np.array([34, 36, 33], np.float32)
        fab = base * shade * (0.8 + 0.25 * rib[..., None]) * (0.9 + 0.2 * grain[..., None])
    out = a * (1 - k[..., None]) + fab * k[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


LED = (57, 224, 255)
"""Status-light colour (cyan: reads as tech, not as a team colour)."""


def gear_atlas(size=1024):
    """Shared gear textures (albedo, normal, ORM roughness, emissive) in the gear UV layout."""
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    rng = np.random.default_rng(11)
    alb = np.zeros((size, size, 3), np.float32)
    hgt = np.zeros((size, size), np.float32)
    rough = np.full((size, size), 0.6, np.float32)
    emis = np.zeros((size, size, 3), np.float32)
    h, q = size // 2, size // 4

    def region(y0, y1, x0, x1):
        yy, xx = np.mgrid[y0:y1, x0:x1]
        return (yy - y0) / (y1 - y0), (xx - x0) / (x1 - x0)

    # Mask: image x 0..h, y 0..h (UV v 0.5..1; image y grows downward as v shrinks).
    fy, fx = region(0, h, 0, h)
    v = 1 - fy  # 0 = chin, 1 = under the visor
    alb[:h, :h] = np.array([30, 32, 34]) * (0.93 + 0.1 * rng.random((h, h, 1)))
    hgt[:h, :h] += np.exp(-(((fx - 0.5) / 0.018) ** 2)) * 0.7  # centre ridge
    panel = np.abs(np.abs(fx - 0.5) - 0.28) < 0.006  # cheek panel seams
    hgt[:h, :h][panel] -= 0.6
    grille = (np.abs(fx - 0.5) < 0.17) & (v > 0.18) & (v < 0.5)
    slots = grille & (np.sin(v * h * np.pi / 6) > 0.25)
    alb[:h, :h][slots] *= 0.3
    hgt[:h, :h][slots] -= 0.9
    rough[:h, :h] = 0.5
    for sx in (0.16, 0.84):  # cheek status LEDs
        dot = ((fx - sx) / 0.02) ** 2 + ((v - 0.62) / 0.015) ** 2 < 1
        emis[:h, :h][dot] = LED
        alb[:h, :h][dot] = LED
    # Visor: image x 0..h, y h..h+q: glossy black glass with a faint HUD line.
    fy, fx = region(h, h + q, 0, h)
    alb[h : h + q, :h] = np.array([10, 12, 15]) + 6 * fy[..., None]
    rough[h : h + q, :h] = 0.08
    hud = np.abs(fy - 0.46) < 0.012
    edge = np.clip(1 - np.abs(fx - 0.5) / 0.46, 0, 1) ** 0.5
    emis[h : h + q, :h][hud] = np.array(LED) * 0.55 * edge[hud][..., None]
    # Shell: image x h..size, all y: satin composite (dark olive-graphite), panel seams, a strap
    # band, fasteners, status-light strips (0.62 m per half tile, like the UVs).
    ppm = size / 0.62
    yy, xx = np.mgrid[0:size, 0:h]
    my, mx = yy / ppm, xx / ppm
    alb[:, h:] = np.array([54, 58, 52]) * (0.9 + 0.08 * rng.random((size, h, 1)))
    seam = ((my % 0.13) < 0.004) | ((mx % 0.11) < 0.004)
    alb[:, h:][seam] *= 0.45
    hgt[:, h:][seam] -= 0.8
    strap = (my % 0.62 > 0.28) & (my % 0.62 < 0.32)
    alb[:, h:][strap] = np.array([96, 86, 64])
    hgt[:, h:][strap] += 0.5
    rough[:, h:] = np.where(strap, 0.85, 0.42)
    bolt = (((mx % 0.11) - 0.012) ** 2 + ((my % 0.13) - 0.012) ** 2) < 0.004**2
    alb[:, h:][bolt] = np.array([120, 124, 126])
    hgt[:, h:][bolt] += 0.6
    led = ((mx % 0.31) > 0.25) & ((mx % 0.31) < 0.257) & ((my % 0.62) > 0.36) & ((my % 0.62) < 0.46)
    alb[:, h:][led] = LED
    emis[:, h:][led] = LED
    rough[:, h:][led] = 0.2
    small = rng.normal(0, 1, (size // 32, h // 32)).astype(np.float32)
    wear = np.asarray(Image.fromarray(small).resize((h, size), Image.Resampling.BICUBIC))
    alb[:, h:] *= (1 + 0.05 * np.clip(wear, -2, 2))[..., None]
    # Armour plates: image x 0..h, y 3q..size (UV v 0..0.25): the plate's far edge (UV v top)
    # is image y 3q. Satin composite, chamfered rim, centre panel line, an LED stripe near the
    # far edge.
    fy, fx = region(3 * q, size, 0, h)
    alb[3 * q :, :h] = np.array([50, 54, 50]) * (0.93 + 0.06 * rng.random((q, h, 1)))
    rim = (fy < 0.05) | (fy > 0.95) | (fx < 0.03) | (fx > 0.97)
    alb[3 * q :, :h][rim] *= 0.62
    hgt[3 * q :, :h] += np.clip(np.minimum.reduce([fy, 1 - fy, fx * 2, (1 - fx) * 2]) * 12, 0, 1)
    line = np.abs(fx - 0.5) < 0.004
    alb[3 * q :, :h][line] *= 0.5
    hgt[3 * q :, :h][line] -= 0.6
    stripe = (fy > 0.12) & (fy < 0.155) & (fx > 0.12) & (fx < 0.88)
    alb[3 * q :, :h][stripe] = LED
    emis[3 * q :, :h][stripe] = LED
    rough[3 * q :, :h] = np.where(stripe, 0.2, 0.38)
    gy, gx = np.gradient(hgt)
    n = np.stack([-gx * 2.5, gy * 2.5, np.ones_like(hgt)], axis=2)
    n /= np.linalg.norm(n, axis=2, keepdims=True)

    def img(a):
        return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))

    # Roughness in G, like glTF ORM (three reads roughnessMap.g).
    orm = np.stack([np.full_like(rough, 255), rough * 255, np.zeros_like(rough)], axis=2)
    return img(alb), img((n * 0.5 + 0.5) * 255), img(orm), img(emis)





def read_glb(data: bytes) -> tuple[dict, bytes]:
    import struct  # noqa: PLC0415

    jl = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20 : 20 + jl])
    off = 20 + jl
    bl = struct.unpack_from('<I', data, off)[0] if len(data) > off else 0
    return doc, data[off + 8 : off + 8 + bl]


def write_glb(doc: dict, blob: bytes) -> bytes:
    import struct  # noqa: PLC0415

    js = json.dumps(doc, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    blob += b'\0' * (-len(blob) % 4)
    body = struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(blob), b'BIN\0') + blob
    return struct.pack('<4sII', b'glTF', 2, 12 + len(body)) + body


def slim_animations(data: bytes, layers: set[str], eps: float = 1e-5) -> bytes:
    """Drop animation data the client never needs (the exporter force-samples every channel of
    every bone): translation/scale channels that hold the node's rest value all clip long (three
    blends a missing track toward the rest value, so this is lossless), and in the action clips
    (`layers`) every channel outside the upper body. Unreferenced accessors and buffer views are
    compacted away."""
    from build_models import read_accessor  # noqa: PLC0415

    doc, blob = read_glb(data)
    nodes = doc['nodes']
    upper, todo = set(), [next(i for i, n in enumerate(nodes) if n.get('name') == LAYER_ROOT)]
    while todo:
        i = todo.pop()
        upper.add(i)
        todo.extend(nodes[i].get('children', []))
    rest = {'translation': [0, 0, 0], 'scale': [1, 1, 1]}
    for anim in doc['animations']:
        keep = []
        for ch in anim['channels']:
            node, path = ch['target']['node'], ch['target']['path']
            if anim['name'] in layers and node not in upper:
                continue
            if path in rest:
                ref = nodes[node].get(path, rest[path])
                vals = read_accessor(doc, [blob], anim['samplers'][ch['sampler']]['output'])
                if all(abs(v - r) <= eps for row in vals for v, r in zip(row, ref)):
                    continue
            keep.append(ch)
        used = sorted({ch['sampler'] for ch in keep})
        remap = {old: new for new, old in enumerate(used)}
        anim['samplers'] = [anim['samplers'][i] for i in used]
        anim['channels'] = [dict(ch, sampler=remap[ch['sampler']]) for ch in keep]
    # Compact: accessors still referenced, then their buffer views.
    refs = []
    for mesh in doc.get('meshes', []):
        for prim in mesh['primitives']:
            refs += [prim['attributes']] + prim.get('targets', [])
            if 'indices' in prim:
                refs.append(prim)
    acc_used = set()
    for r in refs:
        for k, v in r.items():
            if k != 'mode' and k != 'material' and isinstance(v, int):
                acc_used.add(v)
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin:
            acc_used.add(skin['inverseBindMatrices'])
    for anim in doc['animations']:
        for s in anim['samplers']:
            acc_used |= {s['input'], s['output']}
    acc_order = sorted(acc_used)
    acc_map = {old: new for new, old in enumerate(acc_order)}
    accessors = [doc['accessors'][i] for i in acc_order]
    views_used = sorted({a['bufferView'] for a in accessors if 'bufferView' in a})
    view_map, views, out = {}, [], bytearray()
    for old in views_used:
        v = dict(doc['bufferViews'][old])
        start = v.get('byteOffset', 0)
        out += b'\0' * (-len(out) % 4)
        chunk = blob[start : start + v['byteLength']]
        v['byteOffset'] = len(out)
        v['buffer'] = 0
        out += chunk
        view_map[old] = len(views)
        views.append(v)
    doc['accessors'] = [dict(a, bufferView=view_map[a['bufferView']]) if 'bufferView' in a else a
                        for a in accessors]
    doc['bufferViews'] = views
    doc['buffers'] = [{'byteLength': len(out)}]
    for mesh in doc.get('meshes', []):
        for prim in mesh['primitives']:
            prim['attributes'] = {k: acc_map[v] for k, v in prim['attributes'].items()}
            if 'indices' in prim:
                prim['indices'] = acc_map[prim['indices']]
            if 'targets' in prim:
                prim['targets'] = [{k: acc_map[v] for k, v in t.items()} for t in prim['targets']]
    for skin in doc.get('skins', []):
        if 'inverseBindMatrices' in skin:
            skin['inverseBindMatrices'] = acc_map[skin['inverseBindMatrices']]
    for anim in doc['animations']:
        for s in anim['samplers']:
            s['input'], s['output'] = acc_map[s['input']], acc_map[s['output']]
    return write_glb(doc, bytes(out))


def package_stage() -> None:

    from PIL import Image  # noqa: PLC0415

    from build_fparms import recolour  # noqa: PLC0415
    from build_models import json_text  # noqa: PLC0415
    from webp import save_webp  # noqa: PLC0415

    OUT.mkdir(parents=True, exist_ok=True)
    manifest: dict = {'soldiers': {}}
    for p in sorted(BUILD.glob('*.json')):
        aid = p.stem
        info = json.loads(p.read_text())
        tex = RB / info['folder'] / 'Textures'
        pre = info['prefix']
        for kind in ('color', 'normal'):
            atlas = Image.new('RGB', (2048, 2048))
            for part, (ou, ov) in {
                'body': (0, 0),
                'head': (0.5, 0),
                'helmet': (0, 0.5),
                'equipment': (0.5, 0.5),
            }.items():
                name = f'{pre}_{part}_{kind}_acu.tga' if kind == 'color' and part != 'head' else f'{pre}_{part}_{kind}.tga'
                if (tex / name).exists():
                    im = Image.open(tex / name).convert('RGB')
                    if part == 'body':
                        im = scrub(im)
                    if part == 'head':
                        im = balaclava(im, normal=kind == 'normal')
                    im = im.resize((1024, 1024), Image.Resampling.LANCZOS)
                else:  # e.g. Military_Male_04 ships no helmet normal map: flat
                    im = Image.new('RGB', (1024, 1024), (128, 128, 255))
                if kind == 'color' and part != 'head':
                    im = recolour(im, [] if part != 'body' else [
                        [((u - ou) * 2, 1 - (v - ov) * 2) for u, v in t] for t in info['glove']
                    ])
                # UV v is up; image rows go down: the quadrant at v-offset 0.5 is the top half.
                atlas.paste(im, (int(ou * 2048), int((0.5 - ov) * 2048)))
            name = 'albedo' if kind == 'color' else 'normal'
            save_webp(atlas, OUT / f'{aid}_{name}.webp', 'color' if kind == 'color' else 'data', match_jpeg=88)
        layers = {a['name'] for a in ACTIONS}
        (OUT / f'{aid}.glb').write_bytes(slim_animations((BUILD / f'{aid}.glb').read_bytes(), layers))
        manifest['soldiers'][aid] = {k: info[k] for k in ('eye', 'height', 'aimYaw', 'socket', 'clips', 'marks', 'tris')}
        print(aid, info['tris'], 'tris', info['clips'])
    alb, nrm, orm, emis = gear_atlas()
    save_webp(alb, OUT / 'gear_albedo.webp', 'color', match_jpeg=88)
    save_webp(nrm, OUT / 'gear_normal.webp', 'data', match_jpeg=90)
    save_webp(orm, OUT / 'gear_orm.webp', 'data', match_jpeg=88)
    save_webp(emis, OUT / 'gear_emissive.webp', 'color', match_jpeg=88)
    (OUT / 'soldiers.json').write_text(json_text(manifest) + NL, encoding='utf-8', newline=NL)


if __name__ == '__main__':
    if bpy:
        blender_stage()
    else:
        package_stage()
