"""Top-down plan of the generated map data (sanity check / design review).

    python tools/osm/plot.py            → tools/osm/preview/plan.png
"""
import json, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon, Rectangle

d = json.load(open('packages/shared/src/maps/placDefilad/osm.gen.json', encoding='utf8'))
extra = json.load(open(sys.argv[1], encoding='utf8')) if len(sys.argv) > 1 else {}
b = d['bounds']
fig, ax = plt.subplots(figsize=(11, 15), dpi=110)
col = {'asphalt': '#55585e', 'paving': '#c9c1b0', 'grass': '#7da35a', 'metal': '#333', 'sidewalk': '#bbb'}
for f in sorted(d['flats'], key=lambda f: f['layer']):
    ax.add_patch(Polygon(f['pts'], closed=True, fc=col.get(f['mat'], '#999'), ec='none', zorder=f['layer']))
for p in d['prisms']:
    if p.get('backdrop'): c = '#8a8f99'
    else: c = '#3b6ea5' if p['mat'] == 'glass' else '#b5651d'
    ax.add_patch(Polygon(p['pts'], closed=True, fc=c, ec='k', lw=0.2, alpha=0.9, zorder=10))
pal = d['palace']
ax.add_patch(Polygon(pal['outer'], closed=True, fc='#d8b24a', ec='k', lw=0.6, zorder=11))
for h in pal['holes']:
    ax.add_patch(Polygon(h, closed=True, fc='#7da35a', ec='k', lw=0.4, zorder=12))
for t in d['trees']:
    ax.add_patch(plt.Circle((t['x'], t['z']), t['crown'], fc='#2e6b2e', ec='none', alpha=0.55, zorder=13))
for e in d['subwayEntrances']:
    ax.plot(e[0], e[1], 'rv', ms=6, zorder=14)
for c in extra.get('boxes', []):
    ax.add_patch(Polygon(c, closed=True, fc='#ff8c1a', ec='#7a3b00', lw=0.3, alpha=0.9, zorder=14))
for c in extra.get('under', []):
    ax.add_patch(Polygon(c, closed=True, fc='#00c8ff', ec='#006080', lw=0.2, alpha=0.35, zorder=9))
for s in extra.get('spawns', []):
    ax.plot(s[0], s[1], 'o', color='#ff00ff', mec='k', ms=7, zorder=15)
for name, mk in (('north', '^'), ('south', 'v')):
    for s in extra.get('sectionSpawns', {}).get(name, []):
        ax.plot(s[0], s[1], mk, color='#ffffff', mec='#ff00ff', ms=6, zorder=15)
for r in extra.get('rects', []):
    ax.add_patch(Rectangle((r[0], r[1]), r[2]-r[0], r[3]-r[1], fill=False, ec=r[4] if len(r)>4 else 'cyan', lw=1.5, zorder=16))
ax.add_patch(Rectangle((b['minX'], b['minZ']), b['maxX']-b['minX'], b['maxZ']-b['minZ'], fill=False, ec='red', lw=2, zorder=20))
z = d['streets']['zlotaZ']
ax.plot([b['minX'], b['maxX']], [z, z], 'm--', lw=1.5, zorder=21)
ax.set_xlim(b['minX'] - 120, b['maxX'] + 120); ax.set_ylim(b['maxZ'] + 120, b['minZ'] - 120)
ax.set_aspect('equal'); ax.set_facecolor('#e8e4dc'); ax.grid(alpha=0.25)
ax.set_title('Plac Defilad block — generated map (x east, z south; red = playable, magenta = section cut)')
out = 'tools/osm/preview/layout.png' if extra else 'tools/osm/preview/plan.png'
plt.tight_layout(); plt.savefig(out)
print(out)
