"""Shipped textures are WebP (tools/assets/webp.py): encoder rules and what the client loads."""
import io
import json
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import webp

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / 'packages/client/public'
MODELS = PUBLIC / 'models'
# Still PNG on purpose: the baked
# lightmaps (8-bit data, lossless PNG from tools/bake).
NOT_WEBP = ('lightmaps/',)


def rel(p: Path) -> str:
    return p.relative_to(PUBLIC).as_posix()


def webp_file(path: Path) -> Image.Image:
    assert path.is_file(), f'{rel(path)} missing'
    with Image.open(path) as im:
        assert im.format == 'WEBP', f'{rel(path)} is {im.format}, not WebP'
        im.load()
        return im.copy()


class WebpEncoderTest(unittest.TestCase):
    def test_alpha_is_bit_exact_and_colour_under_it_is_kept(self):
        rng = np.random.default_rng(1)
        rgba = rng.integers(0, 256, (64, 64, 4), dtype=np.uint8)
        rgba[..., 3] = np.where(rng.random((64, 64)) < 0.5, 0, rng.integers(1, 256, (64, 64)))
        src = Image.fromarray(rgba, 'RGBA')
        for q in (webp.MIN_QUALITY, webp.COLOR_QUALITY, webp.DATA_QUALITY):
            out = np.asarray(Image.open(io.BytesIO(webp.encode(src, q))).convert('RGBA'))
            self.assertTrue(np.array_equal(out[..., 3], rgba[..., 3]), q)
        # `exact`: fully transparent texels keep (approximately) their colour instead of being
        # flattened, so alpha-edge filtering sees the source's colours (without it: ~10 levels off).
        y, x = np.mgrid[0:64, 0:64]
        card = np.zeros((64, 64, 4), np.uint8)
        card[..., 0], card[..., 1], card[..., 2] = x * 4, y * 4, 120
        card[..., 3] = np.where((x // 8 + y // 8) % 2 == 0, 0, 255)
        clear = card[..., 3] == 0
        out = np.asarray(Image.open(io.BytesIO(webp.encode(Image.fromarray(card, 'RGBA'), 85))).convert('RGBA'))
        err = np.abs(out[..., :3].astype(int) - card[..., :3].astype(int))[clear].mean()
        self.assertLess(err, 4)

    def test_lossless_is_exact(self):
        rng = np.random.default_rng(2)
        src = Image.fromarray(rng.integers(0, 256, (32, 32, 4), dtype=np.uint8), 'RGBA')
        out = Image.open(io.BytesIO(webp.encode(src, None)))
        self.assertTrue(np.array_equal(np.asarray(out.convert('RGBA')), np.asarray(src)))

    def test_matched_quality_is_at_least_as_faithful_as_the_jpeg_and_smaller(self):
        # A smooth + textured test card (gradient, noise, edges): the matched WebP must reach the
        # JPEG's PSNR and, on content like this, cost fewer bytes.
        y, x = np.mgrid[0:256, 0:256]
        rng = np.random.default_rng(3)
        img = np.stack([x, y, (x + y) // 2], -1).astype(np.float64)
        img += rng.normal(0, 12, img.shape) * (x[..., None] > 128)
        img[96:160, 96:160] = [220, 40, 40]
        src = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB')
        jpeg = io.BytesIO()
        src.save(jpeg, 'JPEG', quality=85)
        q = webp.matched_quality(src, 85)
        self.assertGreaterEqual(q, webp.MIN_QUALITY)
        self.assertLessEqual(q, webp.MAX_QUALITY)
        data = webp.encode(src, q)
        self.assertGreaterEqual(webp.psnr(src, Image.open(io.BytesIO(data))),
                                webp.psnr(src, Image.open(io.BytesIO(jpeg.getvalue()))))
        self.assertLess(len(data), jpeg.tell())

    def test_kind_for_shipped_names(self):
        self.assertEqual(webp.kind_for('m01_albedo.jpg'), 'color')
        self.assertEqual(webp.kind_for('gear_emissive.jpg'), 'color')
        self.assertEqual(webp.kind_for('leaf_oak.png'), 'color')
        self.assertEqual(webp.kind_for('oak_impostor.png'), 'color')
        for name in ('atlas_normal_low.jpg', 'rifle_arm.jpg', 'gear_orm.jpg', 'asphalt_rough_512.jpg',
                     'bark_oak_normal.jpg'):
            self.assertEqual(webp.kind_for(name), 'data', name)
        self.assertEqual(webp.kind_for('oak_impostor_n.png'), 'lossless')


class ShippedTexturesTest(unittest.TestCase):
    def test_no_jpeg_or_png_ships_outside_the_exceptions(self):
        stray = [rel(p) for p in PUBLIC.rglob('*') if p.suffix.lower() in ('.jpg', '.jpeg', '.png')
                 and not rel(p).startswith(NOT_WEBP)]
        self.assertEqual(stray, [])
        for p in PUBLIC.rglob('*.webp'):
            webp_file(p)

    def test_prop_gltfs_reference_the_webp_atlas_via_ext_texture_webp(self):
        manifest = json.loads((MODELS / 'manifest.json').read_text())
        for mid in manifest['models']:
            doc = json.loads((MODELS / mid / f'{mid}.gltf').read_text())
            self.assertIn('EXT_texture_webp', doc['extensionsUsed'], mid)
            self.assertIn('EXT_texture_webp', doc['extensionsRequired'], mid)
            for tex in doc['textures']:
                source = tex['extensions']['EXT_texture_webp']['source']
                uri = doc['images'][source]['uri']
                self.assertTrue(uri.endswith('.webp'), (mid, uri))
                webp_file((MODELS / mid / uri).resolve())

    def test_every_texture_the_loaders_request_exists(self):
        # Mirrors the loaders' URL patterns (heroModels, viewGunScans, soldiers, treeModels,
        # propModels, Game sky, foliage canopy); surface sets are covered by surfaceTextures.test.
        want = [MODELS / f'atlas_{m}{s}.webp' for m in ('albedo', 'normal', 'arm') for s in ('', '_low')]
        for hid in json.loads((MODELS / 'heroes/heroes.json').read_text())['models']:
            want += [MODELS / f'heroes/{hid}_{m}{s}.webp' for m in ('albedo', 'normal', 'arm') for s in ('', '_low')]
        for vid in json.loads((MODELS / 'vehicles/vehicles.json').read_text())['models']:
            want += [MODELS / f'vehicles/{vid}_{m}{s}.webp' for m in ('albedo', 'normal', 'arm') for s in ('', '_low')]
        for gid in json.loads((MODELS / 'guns/guns.json').read_text())['guns']:
            want += [MODELS / f'guns/{gid}_{m}.webp' for m in ('albedo', 'normal', 'arm')]
        want += [MODELS / f'knife/knife_{m}{s}.webp' for m in ('albedo', 'normal', 'arm') for s in ('', '_low')]
        want += [MODELS / f'jetpack/jetpack_{m}{s}.webp' for m in ('albedo', 'normal', 'arm', 'emissive') for s in ('', '_low')]
        for sid in json.loads((MODELS / 'soldiers/soldiers.json').read_text())['soldiers']:
            want += [MODELS / f'soldiers/{sid}_{m}.webp' for m in ('albedo', 'normal')]
        want += [MODELS / f'soldiers/gear_{m}.webp' for m in ('albedo', 'normal', 'orm', 'emissive')]
        sky = json.loads((PUBLIC / 'env/sky.json').read_text())['sunny']['file']
        want += [PUBLIC / 'env' / sky, PUBLIC / 'env/sky_sunny.webp', PUBLIC / 'env/sky_sunny_low.webp',
                 PUBLIC / 'tex/canopy_albedo.webp']
        want += [PUBLIC / f'tex/palace-columns-v2/stone_{m}.webp' for m in ('albedo', 'normal', 'orm')]
        for p in want:
            webp_file(p)

    def test_tree_textures_keep_alpha_and_lossless_normals(self):
        species = json.loads((MODELS / 'trees/trees.json').read_text())['species']
        for sid, info in species.items():
            for p in (MODELS / f'trees/leaf_{info["leaf"]}.webp', MODELS / f'trees/{sid}_impostor.webp'):
                im = webp_file(p)
                self.assertEqual(im.mode, 'RGBA', rel(p))
                alpha = np.asarray(im)[..., 3]
                self.assertTrue((alpha == 0).any() and (alpha == 255).any(), rel(p))
            normals = MODELS / f'trees/{sid}_impostor_n.webp'
            self.assertEqual(webp_file(normals).mode, 'RGBA')
            self.assertIn(b'VP8L', normals.read_bytes()[:64], 'impostor normals must be lossless')
            for m in ('color', 'normal'):
                self.assertEqual(webp_file(MODELS / f'trees/bark_{info["bark"]}_{m}.webp').mode, 'RGB')

    def test_texture_byte_budgets(self):
        # ~10 % over the WebP re-encode (2026-09-29): tex 4.5 -> 3.0 MB, env 1.4 MB with the HDRIs.
        size = lambda d: sum(f.stat().st_size for f in (PUBLIC / d).rglob('*') if f.is_file())  # noqa: E731
        self.assertLess(size('tex'), 3_300_000)
        self.assertLess(size('env'), 1_500_000)


if __name__ == '__main__':
    unittest.main()


def test_transcode_warns_when_it_cannot_beat_the_source(capsys, monkeypatch):
    import shutil
    import tempfile

    import webp
    from PIL import Image

    tmp = Path(tempfile.mkdtemp())
    try:
        src = tmp / 'tiny.jpg'
        Image.new('RGB', (8, 8), (120, 90, 60)).save(src, 'JPEG', quality=5)
        size = src.stat().st_size
        tried = []
        # Every quality comes out bigger than the source: the warning path, deterministically.
        monkeypatch.setattr(webp, 'encode', lambda im, q: (tried.append(q), b'x' * (size + 1))[1])
        out, quality = webp.transcode(src, 'color')
        assert out.stat().st_size == size + 1
        top = webp.COLOR_QUALITY
        assert tried == list(range(top, top - webp.TRANSCODE_STEP - 1, -1))
        assert quality == top - webp.TRANSCODE_STEP
        assert 'bigger than its source' in capsys.readouterr().err
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
