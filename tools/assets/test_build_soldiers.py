"""Offline tests for the soldier build's pure helpers (no Blender): action-clip sampling and the
animation slimming of the shipped GLBs."""
import json
import struct
import unittest
from pathlib import Path

from build_models import read_accessor
from build_soldiers import ACTIONS, LAYER_ROOT, SRC_FPS, read_glb, sample_frames, slim_animations, write_glb

ROOT = Path(__file__).resolve().parents[2]


def glb(nodes, animations, floats):
    """A tiny GLB: every accessor is a float view into one buffer (`floats`: [(type, values)])."""
    blob, views, accessors = b'', [], []
    for kind, values in floats:
        data = struct.pack(f'<{len(values)}f', *values)
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)})
        width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[kind]
        accessors.append({'bufferView': len(views) - 1, 'componentType': 5126, 'type': kind,
                          'count': len(values) // width})
        blob += data
    doc = {'asset': {'version': '2.0'}, 'nodes': nodes, 'animations': animations, 'accessors': accessors,
           'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]}
    return write_glb(doc, blob)


class SoldierBuildTest(unittest.TestCase):
    def test_split_clips_put_the_mark_at_the_sim_windup_at_scene_rate(self):
        spec = {'window': (60, 106), 'mark': 86, 'time': (0.32, 0.35)}
        frames, mark = sample_frames(spec, 30)
        k = 30 / SRC_FPS
        self.assertAlmostEqual(frames[0], 60 * k)
        self.assertAlmostEqual(frames[-1], 106 * k)
        nw = round(0.32 * 30)
        self.assertAlmostEqual(frames[nw], 86 * k)  # the release lands on the output frame…
        self.assertAlmostEqual(mark, round(nw / 30, 4))  # …whose clip time the manifest records
        self.assertLess(abs(mark - 0.32), 1 / 30)
        self.assertEqual(len(frames) - 1, nw + round(0.35 * 30))
        # Uniform clips: the whole window over the sim duration; native clips keep their speed.
        frames, mark = sample_frames({'window': (13, 67), 'time': 2.1}, 30)
        self.assertEqual((len(frames) - 1, mark), (63, None))
        frames, _ = sample_frames({'window': (0, 8), 'time': None}, 30)
        self.assertEqual(len(frames) - 1, 10)  # 8 frames at 24 fps = 10 at 30

    def test_every_action_names_a_mode_and_timing(self):
        for spec in ACTIONS:
            self.assertIn(spec['mode'], ('grip', 'free', 'body'))
            if isinstance(spec['time'], tuple):
                self.assertTrue(spec['window'][0] < spec['mark'] < spec['window'][1], spec['name'])
            if spec['mode'] == 'grip':
                self.assertIn('ref', spec)

    def test_slimming_drops_rest_valued_and_off_layer_channels_and_compacts(self):
        nodes = [
            {'name': 'Armature', 'children': [1, 2]},
            {'name': LAYER_ROOT, 'children': [3], 'translation': [0, 1, 0]},
            {'name': 'Bip01 L Thigh', 'translation': [0.1, 0.9, 0]},
            {'name': 'Bip01 R Hand'},
        ]
        floats = [
            ('SCALAR', [0, 1]),  # 0 times
            ('VEC3', [0.1, 0.9, 0, 0.1, 0.9, 0]),  # 1 thigh translation = rest: drop
            ('VEC4', [0, 0, 0, 1, 0, 0.1, 0, 0.995]),  # 2 a rotation: keep
            ('VEC3', [1, 1, 1, 1, 1, 1]),  # 3 unit scale: drop
            ('VEC3', [0, 1, 0, 0, 1.2, 0]),  # 4 moving spine: keep
            ('VEC4', [0, 0, 0, 1, 0.1, 0, 0, 0.995]),  # 5 hand rotation: keep
        ]
        ch = lambda s, node, path: {'sampler': s, 'target': {'node': node, 'path': path}}  # noqa: E731
        sm = lambda out: {'input': 0, 'output': out}  # noqa: E731
        anims = [
            {'name': 'idle', 'samplers': [sm(1), sm(2), sm(3)],
             'channels': [ch(0, 2, 'translation'), ch(1, 2, 'rotation'), ch(2, 1, 'scale')]},
            {'name': 'reload', 'samplers': [sm(2), sm(4), sm(5)],
             'channels': [ch(0, 2, 'rotation'), ch(1, 1, 'translation'), ch(2, 3, 'rotation')]},
        ]
        out, blob = read_glb(slim_animations(glb(nodes, anims, floats), {'reload'}))
        idle, reload = out['animations']
        self.assertEqual([(c['target']['node'], c['target']['path']) for c in idle['channels']], [(2, 'rotation')])
        self.assertEqual([(c['target']['node'], c['target']['path']) for c in reload['channels']],
                         [(1, 'translation'), (3, 'rotation')])
        # Accessors 1 and 3 are gone; the data that stayed still reads back exactly.
        self.assertEqual(len(out['accessors']), 4)
        self.assertEqual(len(out['bufferViews']), 4)
        hand = reload['samplers'][reload['channels'][1]['sampler']]['output']
        vals = read_accessor(out, [blob], hand)
        self.assertAlmostEqual(vals[1][0], 0.1, places=6)
        self.assertEqual(out['buffers'][0]['byteLength'], len(blob))
        json.dumps(out)  # still plain JSON

    def test_shipped_manifest_lists_every_action_and_its_marks(self):
        manifest = json.loads((ROOT / 'packages/client/public/models/soldiers/soldiers.json').read_text())
        for aid, info in manifest['soldiers'].items():
            for spec in ACTIONS:
                self.assertIn(spec['name'], info['clips'], aid)
            self.assertEqual(set(info['marks']), {'throw', 'strike'}, aid)


if __name__ == '__main__':
    unittest.main()
