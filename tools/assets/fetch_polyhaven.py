"""Fetch the CC0 Poly Haven assets for the visual-quality slice (Market first).

    python tools/assets/fetch_polyhaven.py --dry-run   # list files + total size
    python tools/assets/fetch_polyhaven.py             # download to tools/assets/raw/polyhaven/

Everything on Poly Haven is CC0 (https://polyhaven.com/license). Raw downloads are git-ignored;
only processed, compressed assets that the game actually uses get committed (and logged in
ASSETS.md at that point). A manifest of what was fetched is written next to the files.
"""
import json
import os
import sys
import urllib.request

UA = {'User-Agent': 'warsaw-downtown-asset-fetch/1.0 (private game project; CC0 assets)'}
ROOT = os.path.join(os.path.dirname(__file__), 'raw', 'polyhaven')

HDRIS = {  # 2k .hdr: sky + image-based lighting per weather preset
    'dresden_square': '2k',  # sunny, European square
    'potsdamer_platz': '2k',  # overcast / rain
    'palermo_square': '2k',  # sunset → dusk
    'hansaplatz': '2k',  # night
}
TEXTURES = {  # map in game → Poly Haven texture, resolution
    'asphalt_02': '2k',  # roads
    'square_concrete_pavers': '2k',  # pavements
    'granite_tile_04': '2k',  # Plac Defilad granite
    'large_sandstone_blocks': '2k',  # Palace of Culture (sandstone clad)
    'plastered_wall_05': '1k',  # generic facades
    'concrete_wall_008': '1k',
    'grey_plaster_02': '1k',
    'wood_planks': '1k',  # crates, stalls
    'worn_corrugated_iron': '1k',  # containers
    'metal_plate': '1k',
    'rusty_painted_metal': '1k',  # wrecks
    'leafy_grass': '1k',  # lawns
}
TEXTURE_MAPS = ['Diffuse', 'nor_gl', 'Rough', 'AO']
MODELS = {  # glTF with 1k textures
    m: '1k'
    for m in [
        'wooden_crate_01',
        'wooden_crate_02',
        'wooden_military_crate',
        'barrel_03',
        'wooden_barrels_01',
        'concrete_road_barrier',
        'concrete_road_barrier_02',
        'covered_car',
        'metal_trash_can',
        'street_lamp_01',
        'street_lamp_02',
        'fire_hydrant',  # retired model: its textures still fill its atlas tile
        'utility_box_01',
        'utility_box_02',
        'modular_street_seating',
        'painted_wooden_bench',
        'planter_box_01',
        'planter_box_02',
        'planter_box_03',
        'shrub_01',
        'shrub_02',
        'shrub_03',
        'shrub_04',
        'old_tyre',
        'cardboard_box_01',
        'plastic_crate_01',
        'trashbag',
        'power_box_01',
        'portable_generator',
        'modular_chainlink_fence',
        'wooden_picnic_table',
    ]
}


def get_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def plan():
    files = []  # (kind, id, relpath, url, size)
    for hid, res in HDRIS.items():
        f = get_json(f'https://api.polyhaven.com/files/{hid}')['hdri'][res]['hdr']
        files.append(('hdri', hid, f'hdri/{hid}_{res}.hdr', f['url'], f['size']))
    for tid, res in TEXTURES.items():
        d = get_json(f'https://api.polyhaven.com/files/{tid}')
        for m in TEXTURE_MAPS:
            if m not in d:
                continue
            f = d[m][res]['jpg']
            files.append(('texture', tid, f'textures/{tid}/{tid}_{m.lower()}_{res}.jpg', f['url'], f['size']))
    for mid, res in MODELS.items():
        g = get_json(f'https://api.polyhaven.com/files/{mid}')['gltf'][res]['gltf']
        files.append(('model', mid, f'models/{mid}/{mid}_{res}.gltf', g['url'], g['size']))
        for rel, inc in g.get('include', {}).items():
            files.append(('model', mid, f'models/{mid}/{rel}', inc['url'], inc['size']))
    return files


def main():
    files = plan()
    total = sum(f[4] for f in files)
    by = {}
    for f in files:
        by[f[0]] = by.get(f[0], 0) + f[4]
    print(f'{len(files)} files, {total / 1e6:.1f} MB total')
    for k, v in by.items():
        print(f'  {k}: {v / 1e6:.1f} MB')
    if '--dry-run' in sys.argv:
        return
    manifest = []
    for kind, aid, rel, url, size in files:
        # Never trust API-supplied paths: the destination must stay inside ROOT.
        dest = os.path.normpath(os.path.join(ROOT, rel))
        if os.path.commonpath([os.path.abspath(dest), os.path.abspath(ROOT)]) != os.path.abspath(ROOT):
            raise SystemExit(f'refusing to write outside {ROOT}: {rel!r}')
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if not (os.path.exists(dest) and os.path.getsize(dest) == size):
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r, open(dest, 'wb') as out:
                out.write(r.read())
        manifest.append({'kind': kind, 'id': aid, 'file': rel, 'bytes': size, 'source': url, 'license': 'CC0 1.0 (Poly Haven)'})
    with open(os.path.join(ROOT, 'manifest.json'), 'w', encoding='utf8') as f:
        json.dump(manifest, f, indent=1)
    print('downloaded to', ROOT)


if __name__ == '__main__':
    main()
