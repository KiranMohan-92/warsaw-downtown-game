"""Offline, geometry-driven weathering in the static scan's game frame (+X front).

No runtime textures or shaders are added. UV rasterization retains the approved atlas;
topological boundaries, dihedral edges and baked AO place damage before any noise is used.
Albedo is sRGB; material masks and the millimetre-scale relief are linear data.
"""

import numpy as np


def smooth(lo, hi, value):
    t = np.clip((value - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def _features(vertices, faces):
    """Weld only coincident positions for analysis; UV seams are never damage edges."""
    points, inverse = np.unique(vertices[:, :3], axis=0, return_inverse=True)
    triangles = inverse[faces]
    p = points[triangles]
    n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    edges = {}
    for f, tri in enumerate(triangles):
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            if a != b:
                edges.setdefault(tuple(sorted((int(a), int(b)))), []).append(f)
    adjacency = [[] for _ in points]
    crease, boundary = [], []
    for (a, b), linked in edges.items():
        adjacency[a].append(b)
        adjacency[b].append(a)
        if len(linked) == 1:
            boundary.append((a, b))
        else:
            dot = np.min(n[linked] @ n[linked].T)
            if dot < 0.57:  # >55 degrees: folded panel/seam
                crease.append((a, b))
            # The scan closes the thickness around torn lips: it is watertight even
            # where the vehicle has openings. Sharp concave returns and doubled-back
            # sheet edges locate those rims; a UV boundary alone cannot locate them.
            concave = np.dot(n[linked[0]], p[linked[-1]].mean(axis=0)-p[linked[0]].mean(axis=0)) > 0
            if (dot < -0.2 or (dot < 0.35 and concave)) and min(points[a, 1], points[b, 1]) > 0.55:
                boundary.append((a, b))
    components = np.full(len(points), -1, dtype=int)
    for seed in range(len(points)):
        if components[seed] >= 0:
            continue
        stack = [seed]
        components[seed] = seed
        while stack:
            for j in adjacency[stack.pop()]:
                if components[j] < 0:
                    components[j] = seed
                    stack.append(j)
    fields = []
    for segments in (sorted(set(crease + boundary)), boundary):
        indices = np.asarray(segments, dtype=int).reshape(-1, 2)
        fields.append((points[indices], components[indices[:, 0]]))
    return fields, components[inverse]


def _distance_field(pixels, components, segments, segment_components):
    """Exact distance within 50 cm, using one consistent spatial field per component.

    Expanded segment bounds populate every intersected cell. Unlike triangle-local
    nearest candidates, this cannot introduce a jump across a triangulation edge.
    """
    reach, cell_size = 0.5, 0.3
    keys = np.column_stack((np.floor(pixels/cell_size).astype(int), components))
    cells, inverse, counts = np.unique(keys, axis=0, return_inverse=True, return_counts=True)
    grid = {tuple(key): [] for key in cells}
    for index, (segment, component) in enumerate(zip(segments, segment_components)):
        low = np.floor((segment.min(axis=0)-reach)/cell_size).astype(int)
        high = np.floor((segment.max(axis=0)+reach)/cell_size).astype(int)
        for x in range(low[0], high[0]+1):
            for y in range(low[1], high[1]+1):
                for z in range(low[2], high[2]+1):
                    key = (x, y, z, component)
                    if key in grid:
                        grid[key].append(index)
    order, start = np.argsort(inverse), 0
    distance = np.full(len(pixels), reach)
    for key, count in zip(cells, counts):
        ids = order[start:start+count]
        start += count
        candidates = grid[tuple(key)]
        if not candidates:
            continue
        a, b = segments[candidates, 0], segments[candidates, 1]
        direction = b-a
        length2 = np.maximum((direction*direction).sum(axis=1), 1e-12)
        for offset in range(0, len(ids), 256):
            chunk = ids[offset:offset+256]
            p = pixels[chunk]
            dot = np.einsum('ik,jk->ij', p, direction) - (a*direction).sum(axis=1)
            t = np.clip(dot/length2, 0, 1)
            d2 = ((p*p).sum(axis=1)[:, None] + (a*a).sum(axis=1)
                  - 2*np.einsum('ik,jk->ij', p, a) - 2*t*dot + t*t*length2)
            distance[chunk] = np.minimum(reach, np.sqrt(np.maximum(d2.min(axis=1), 0)))
    return distance


def geometry_maps(vertices, faces, size):
    """Rasterize world position/normal and true surface distances at texel centres."""
    v, f = np.asarray(vertices, dtype=np.float64), np.asarray(faces, dtype=int)
    fields, components = _features(v, f)
    values = v[:, :6]
    raster = np.zeros((size, size, 8), dtype=np.float32)
    valid = np.zeros((size, size), dtype=bool)
    component_map = np.zeros((size, size), dtype=int)
    for tri in f:
        uv = v[tri, 6:8] * size - 0.5
        low = np.maximum(np.ceil(uv.min(axis=0)).astype(int), 0)
        high = np.minimum(np.floor(uv.max(axis=0)).astype(int), size - 1)
        if np.any(high < low):
            continue
        a, b = uv[1] - uv[0], uv[2] - uv[0]
        det = a[0] * b[1] - a[1] * b[0]
        if abs(det) < 1e-10:
            continue
        yy, xx = np.mgrid[low[1]:high[1]+1, low[0]:high[0]+1]
        dx, dy = xx - uv[0, 0], yy - uv[0, 1]
        s, t = (dx*b[1] - dy*b[0])/det, (a[0]*dy - a[1]*dx)/det
        inside = (s >= -1e-6) & (t >= -1e-6) & (s+t <= 1+1e-6)
        rows, cols = yy[inside], xx[inside]
        interpolated = ((1-s[inside]-t[inside])[:, None] * values[tri[0]]
                        + s[inside, None] * values[tri[1]]
                        + t[inside, None] * values[tri[2]])
        raster[rows, cols, :6] = interpolated
        component_map[rows, cols] = components[tri[0]]
        valid[rows, cols] = True
    for field, (segments, segment_components) in enumerate(fields):
        raster[..., 6+field][valid] = _distance_field(raster[..., :3][valid], component_map[valid],
                                                     segments, segment_components)
    p, n = raster[..., :3], raster[..., 3:6]
    n = n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-8)
    radius = np.minimum(np.hypot(p[..., 0]+1.42, p[..., 1]-0.45),
                        np.hypot(p[..., 0]-1.57, p[..., 1]-0.45))
    wheel = (np.abs(p[..., 2]) > 0.65) & (np.abs(p[..., 2]) < 1.08) & (radius < 0.46)
    return dict(position=p, normal=n, valid=valid, body=valid & ~wheel,
                edge=np.exp(-raster[..., 6]/0.055) * valid,
                holes=np.exp(-raster[..., 7]/0.085) * valid)


def _noise(p, scale):
    """Continuous deterministic value noise in metres, never in atlas coordinates."""
    q = p * np.asarray(scale)
    cell = np.floor(q)
    t = q - cell
    t = t*t*(3-2*t)
    result = np.zeros(p.shape[:-1])
    for x in (0, 1):
        for y in (0, 1):
            for z in (0, 1):
                c = cell + (x, y, z)
                h = np.sin(c[..., 0]*127.1 + c[..., 1]*311.7 + c[..., 2]*74.7) * 43758.5453
                weight = (t[..., 0] if x else 1-t[..., 0])
                weight = weight * (t[..., 1] if y else 1-t[..., 1])
                weight = weight * (t[..., 2] if z else 1-t[..., 2])
                result += (h-np.floor(h))*weight
    return result


def _runs(maps):
    """Project real edge/tear donors downwards; separate each side to avoid ghost stains.

    Four planar donor fields are temporary bake data. A streak can only exist BELOW a
    measured damage edge. The normal selects side vs end projection, never UV direction.
    """
    p, n, valid = maps['position'], maps['normal'], maps['body']
    donor = np.maximum(maps['holes'], maps['edge'] * 0.65)
    result = np.zeros(valid.shape)
    step, size = 0.025, 512
    y = np.clip((p[..., 1]/step).astype(int), 0, size-1)
    for axis, normal_axis in ((0, 2), (2, 0)):
        x = np.clip(((p[..., axis]+6)/step).astype(int), 0, size-1)
        for sign in (-1, 1):
            side = valid & (n[..., normal_axis]*sign > 0.35)
            field = np.zeros((size, size))
            np.maximum.at(field, (y[side], x[side]), donor[side])
            flow = np.zeros_like(field)
            # Each donor trails at most 60 cm; gaps are bridged in world space, not UV space.
            for offset in range(1, 25):
                flow[:-offset] = np.maximum(flow[:-offset], field[offset:] * np.exp(-offset/9))
            result = np.maximum(result, flow[y, x] * side)
    return result


def weather_surface(maps, ao):
    """Return sRGB reflectance and PBR layers; broad flat panels retain chalky paint."""
    p, n = maps['position'], maps['normal']
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    edge, holes = maps['edge'], maps['holes']
    fine, grain = _noise(p, 48), _noise(p, 135)
    grime = _noise(p, (4, 1.4, 4))
    low = 1-smooth(0.35, 1.15, y)
    cavity = 1-np.clip(ao, 0, 1)
    radius = np.minimum(np.hypot(x+1.42, y-0.45), np.hypot(x-1.57, y-0.45))
    arch = (1-smooth(0.04, 0.17, np.abs(radius-0.53))) * smooth(0.5, 0.75, np.abs(z))
    runs = _runs(maps) * smooth(0.35, 0.65, _noise(p, (65, 1.8, 65)))
    driver = np.maximum.reduce((edge*0.95, holes*0.95, low*0.72, cavity*0.8, arch*0.65, runs*0.85))
    rust = smooth(0.22, 0.66, driver * (0.72+0.28*fine))

    # Fire originates inside the cab/engine, with soft plumes around the existing openings.
    cabin = np.exp(-((x-0.48)/0.85)**2 - ((y-1.65)/0.8)**2 - (z/1.5)**4)
    engine = np.exp(-((x-1.65)/0.75)**2 - ((y-1.02)/0.52)**2)
    opening = holes * smooth(0.65, 1.1, y)
    soot = np.clip(np.maximum(cabin*0.92, engine*0.95) + opening*0.28 + cavity*0.25, 0, 1)
    soot *= 0.88+grime*0.12
    rust *= 1-soot*0.85
    steel = smooth(0.5, 0.9, edge) * smooth(0.58, 0.74, fine) * (1-soot) * 0.95
    rust *= 1-steel

    def mix(a, b, weight):
        return np.asarray(a)*(1-weight[..., None]) + np.asarray(b)*weight[..., None]

    # Low-chroma pigments: a warm umber and red-brown, never orange islands.
    paint_colour = mix((0.365, 0.381, 0.327), (0.455, 0.463, 0.405), grime*0.55+fine*0.25)
    rust_colour = mix((0.305, 0.251, 0.224), (0.385, 0.304, 0.269), fine)
    colour = mix(paint_colour, rust_colour, rust)
    colour = mix(colour, (0.31, 0.29, 0.255), low*grime*0.22+cavity*0.12)
    # Thin fresh run marks, limited to actual drainage; their saturation remains below .45.
    colour = mix(colour, (0.40, 0.305, 0.25), runs*rust*0.14)
    heat = np.maximum(cabin, engine)*(1-soot)*0.24
    tempered = mix((0.32, 0.345, 0.37), (0.39, 0.365, 0.31), fine)
    colour = mix(colour, tempered, heat)
    colour = mix(colour, (0.24, 0.245, 0.243), soot)
    colour = mix(colour, (0.395, 0.405, 0.408), steel)
    rough = (0.68*(1-rust)+0.91*rust)*(1-soot)+0.94*soot
    rough = rough*(1-steel)+0.46*steel
    metal = steel*0.8
    # The 2–4 cm pits survive the 512 atlas; sub-centimetre grain alone averages away.
    relief = ((_noise(p, 24)-0.5)*0.002 + (fine-0.5)*0.0028)*(rust+soot*0.3)
    relief += (grain-0.5)*0.0008
    # Drainage is a stain, not an incised groove: only physical damaged edges flake.
    relief -= smooth(0.25, 0.6, np.maximum(edge, holes))*smooth(0.35, 0.65, fine)*0.0018

    wheel = maps['valid'] & ~maps['body']
    rim = wheel & (radius < 0.24)
    rubber = wheel & ~rim
    ash = smooth(0.4, 0.8, grain) * np.clip(n[..., 1]*0.5+0.5, 0, 1)
    colour = mix(colour, mix((0.22, 0.224, 0.22), (0.38, 0.378, 0.363), ash*0.55), rubber)
    colour = mix(colour, mix((0.27, 0.24, 0.22), (0.34, 0.29, 0.26), fine), rim)
    rough = np.where(wheel, 0.92, rough)
    metal = np.where(wheel, 0.04*rim, metal)
    relief = np.where(rubber, (grain-0.5)*0.001, relief)
    return dict(albedo=np.clip(colour, 0, 1), roughness=rough, metal=metal, height=relief,
                rust=rust, soot=soot, steel=steel, paint=(1-rust)*(1-soot)*(1-steel), low=low)


def dilate(values, valid, steps=12):
    """Mip gutters from neighbouring covered texels; never wrap opposite atlas edges."""
    out, mask = values.copy(), valid.copy()
    for _ in range(steps):
        previous, covered = out.copy(), mask.copy()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            dst = (slice(max(dy, 0), min(len(mask)+dy, len(mask))),
                   slice(max(dx, 0), min(len(mask)+dx, len(mask))))
            src = (slice(max(-dy, 0), min(len(mask)-dy, len(mask))),
                   slice(max(-dx, 0), min(len(mask)-dx, len(mask))))
            fill = ~mask[dst] & covered[src]
            out[dst][fill] = previous[src][fill]
            mask[dst][fill] = True
    return out
