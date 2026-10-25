"""raw_models: shipped meshopt-packed models are decoded on demand, never read from a stale copy."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import raw_models
from build_models import read_accessor

CRATE = raw_models.MODELS / 'crate/crate.gltf'


def positions(path: Path) -> list:
    doc = json.loads(path.read_text())
    buffers = [(path.parent / b['uri']).read_bytes() for b in doc['buffers']]
    return read_accessor(doc, buffers, doc['meshes'][0]['primitives'][0]['attributes']['POSITION'])


class RawModelsTest(unittest.TestCase):
    def setUp(self):
        # A private unpack dir, so the test never touches (or trusts) the shared cache.
        self.tmp = Path(tempfile.mkdtemp())
        patcher = mock.patch.object(raw_models, 'UNPACKED', self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_plain_file_passes_through(self):
        plain = self.tmp / 'plain.gltf'
        plain.write_text(json.dumps({'asset': {'version': '2.0'}}))
        self.assertEqual(raw_models.raw_model(plain), plain.resolve())

    def test_packed_file_decodes_to_a_plain_copy(self):
        self.assertTrue(raw_models.is_packed(CRATE))
        out = raw_models.raw_model(CRATE)
        self.assertEqual(out, self.tmp / 'crate/crate.gltf')
        self.assertFalse(raw_models.is_packed(out))
        self.assertEqual(len(positions(out)), json.loads(CRATE.read_text())['accessors'][0]['count'])

    def test_cached_copy_is_reused_until_the_shipped_file_is_newer(self):
        out = raw_models.raw_model(CRATE)
        with mock.patch.object(raw_models.subprocess, 'run') as run:
            raw_models.raw_model(CRATE)
            run.assert_not_called()  # up to date: no re-decode
        # A shipped file newer than the copy (a rebuild + repack) forces a fresh decode.
        stale = CRATE.stat().st_mtime - 10
        os.utime(out, (stale, stale))
        with mock.patch.object(raw_models.subprocess, 'run', wraps=raw_models.subprocess.run) as run:
            raw_models.raw_model(CRATE)
            run.assert_called_once()

    def test_failed_unpack_is_an_error_not_a_packed_read(self):
        with mock.patch.object(raw_models.subprocess, 'run'):  # "succeeds" without writing anything
            with self.assertRaises(SystemExit):
                raw_models.raw_model(CRATE)


if __name__ == '__main__':
    unittest.main()
