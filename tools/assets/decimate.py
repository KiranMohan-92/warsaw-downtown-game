"""Quadric-error mesh simplification (Garland & Heckbert 1997), pure Python.

Used by build_models.py to bring film-grade Poly Haven scans (5k-90k triangles) down to game
budgets (a few hundred triangles for a crate that appears a thousand times).

Half-edge collapses only (a vertex moves onto a neighbour), so no new positions or attributes
are ever invented: every surviving vertex keeps its scanned normal and uv. Attribute seams (a
position with several uv/normal "wedges", e.g. the edge of a uv island or a hard edge) are
handled wedge by wedge: a collapse a -> b is allowed only if every wedge of a maps to exactly one
wedge of b through a triangle that contains both, so textures never smear across an island.
Mesh borders only collapse along the border, uv islands and borders are held by constraint
planes, and a collapse that flips a triangle (in space or in uv) is refused.

    simplify(vertices, triangles, target) -> (vertices, triangles)

`vertices` are (x, y, z, nx, ny, nz, u, v) tuples; `triangles` are index triples. Deterministic.
"""

import heapq
import math

Vertex = tuple[float, float, float, float, float, float, float, float]


def _plane_quadric(a: float, b: float, c: float, d: float, w: float) -> list[float]:
    return [
        w * a * a,
        w * a * b,
        w * a * c,
        w * a * d,
        w * b * b,
        w * b * c,
        w * b * d,
        w * c * c,
        w * c * d,
        w * d * d,
    ]


def _add(q: list[float], r: list[float]) -> None:
    for i in range(10):
        q[i] += r[i]


def _error(q: list[float], x: float, y: float, z: float) -> float:
    return (
        q[0] * x * x
        + 2 * q[1] * x * y
        + 2 * q[2] * x * z
        + 2 * q[3] * x
        + q[4] * y * y
        + 2 * q[5] * y * z
        + 2 * q[6] * y
        + q[7] * z * z
        + 2 * q[8] * z
        + q[9]
    )


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(a):
    return math.sqrt(_dot(a, a))


def _uv_area(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])


def simplify(
    vertices: list[Vertex],
    triangles: list[tuple[int, int, int]],
    target: int,
    *,
    seam_weight: float = 100.0,
    min_normal_dot: float = 0.25,
    length_bias: float = 1e-4,
) -> tuple[list[Vertex], list[tuple[int, int, int]]]:
    """Collapse edges until at most `target` triangles remain (or nothing else may collapse)."""
    # ---- points (unique positions) and wedges (unique position + normal + uv) -------------------
    point_of_key: dict[tuple, int] = {}
    pos: list[list[float]] = []
    wedge_of_key: dict[tuple, int] = {}
    wedge_point: list[int] = []
    wedge_attr: list[tuple] = []  # (nx, ny, nz, u, v)
    remap: list[int] = []
    for vx in vertices:
        pk = (round(vx[0], 6), round(vx[1], 6), round(vx[2], 6))
        p = point_of_key.get(pk)
        if p is None:
            p = len(pos)
            point_of_key[pk] = p
            pos.append([vx[0], vx[1], vx[2]])
        wk = (p, round(vx[3], 5), round(vx[4], 5), round(vx[5], 5), round(vx[6], 7), round(vx[7], 7))
        w = wedge_of_key.get(wk)
        if w is None:
            w = len(wedge_point)
            wedge_of_key[wk] = w
            wedge_point.append(p)
            wedge_attr.append((vx[3], vx[4], vx[5], vx[6], vx[7]))
        remap.append(w)

    faces: list[list[int] | None] = []
    seen: set[tuple[int, int, int]] = set()
    for t in triangles:
        f = [remap[t[0]], remap[t[1]], remap[t[2]]]
        pa, pb, pc = (wedge_point[w] for w in f)
        if pa == pb or pb == pc or pa == pc:
            continue
        key = tuple(sorted((pa, pb, pc)))
        if key in seen:  # duplicate (or back-to-back) triangle: materials are double-sided
            continue
        seen.add(key)
        n = _cross(_sub(pos[pb], pos[pa]), _sub(pos[pc], pos[pa]))
        if _norm(n) < 1e-14:
            continue
        faces.append(f)

    npts = len(pos)
    pfaces: list[set[int]] = [set() for _ in range(npts)]
    for fi, f in enumerate(faces):
        for w in f:
            pfaces[wedge_point[w]].add(fi)

    # ---- quadrics: face planes + constraint planes along borders and uv/normal seams -----------
    Q = [[0.0] * 10 for _ in range(npts)]
    edge_faces: dict[tuple[int, int], list[int]] = {}
    for fi, f in enumerate(faces):
        p = [pos[wedge_point[w]] for w in f]
        n = _cross(_sub(p[1], p[0]), _sub(p[2], p[0]))
        ln = _norm(n)
        n = (n[0] / ln, n[1] / ln, n[2] / ln)
        q = _plane_quadric(n[0], n[1], n[2], -_dot(n, p[0]), 1.0)
        for w in f:
            _add(Q[wedge_point[w]], q)
        for i in range(3):
            a, b = wedge_point[f[i]], wedge_point[f[(i + 1) % 3]]
            edge_faces.setdefault((min(a, b), max(a, b)), []).append(fi)
    locked = [False] * npts
    for (a, b), fl in edge_faces.items():
        if len(fl) > 2:
            locked[a] = locked[b] = True
            continue
        seam = len(fl) == 1
        if not seam:
            f0, f1 = faces[fl[0]], faces[fl[1]]
            for p in (a, b):
                w0 = next(w for w in f0 if wedge_point[w] == p)
                w1 = next(w for w in f1 if wedge_point[w] == p)
                if w0 != w1:
                    seam = True
        if not seam:
            continue
        for fi in fl:
            f = faces[fi]
            p = [pos[wedge_point[w]] for w in f]
            fn = _cross(_sub(p[1], p[0]), _sub(p[2], p[0]))
            e = _sub(pos[b], pos[a])
            cn = _cross(e, fn)
            lc = _norm(cn)
            if lc < 1e-14:
                continue
            cn = (cn[0] / lc, cn[1] / lc, cn[2] / lc)
            q = _plane_quadric(cn[0], cn[1], cn[2], -_dot(cn, pos[a]), seam_weight)
            _add(Q[a], q)
            _add(Q[b], q)

    alive = len(faces)
    removed = [False] * npts
    ver = [0] * npts

    def neighbours(p: int) -> set[int]:
        out: set[int] = set()
        for fi in pfaces[p]:
            for w in faces[fi]:  # type: ignore[union-attr]
                out.add(wedge_point[w])
        out.discard(p)
        return out

    def is_border(p: int, nb: set[int]) -> bool:
        return any(len(pfaces[p] & pfaces[n]) == 1 for n in nb)

    def cost(a: int, b: int) -> float:
        q = [Q[a][i] + Q[b][i] for i in range(10)]
        pb = pos[b]
        d = _sub(pb, pos[a])
        return _error(q, pb[0], pb[1], pb[2]) + length_bias * _dot(d, d)

    heap: list[tuple[float, int, int, int, int]] = []

    def push_edges(p: int) -> None:
        for n in neighbours(p):
            if not locked[p]:
                heapq.heappush(heap, (cost(p, n), p, n, ver[p], ver[n]))
            if not locked[n]:
                heapq.heappush(heap, (cost(n, p), n, p, ver[n], ver[p]))

    for p in range(npts):
        if pfaces[p] and not locked[p]:
            for n in neighbours(p):
                heapq.heappush(heap, (cost(p, n), p, n, ver[p], ver[n]))

    def try_collapse(a: int, b: int) -> bool:
        nonlocal alive
        shared = pfaces[a] & pfaces[b]
        if not shared or len(shared) > 2:
            return False
        na = neighbours(a)
        nb = neighbours(b)
        opposite = set()
        for fi in shared:
            for w in faces[fi]:  # type: ignore[union-attr]
                p = wedge_point[w]
                if p != a and p != b:
                    opposite.add(p)
        if (na & nb) != opposite:
            return False  # link condition: the collapse would pinch the surface
        if is_border(a, na) and len(shared) != 1:
            return False  # border vertices only slide along the border
        # Wedge map a -> b through the triangles that contain both.
        wmap: dict[int, int] = {}
        for fi in shared:
            f = faces[fi]
            wa = next(w for w in f if wedge_point[w] == a)  # type: ignore[union-attr]
            wb = next(w for w in f if wedge_point[w] == b)  # type: ignore[union-attr]
            if wmap.setdefault(wa, wb) != wb:
                return False
        moved = [fi for fi in pfaces[a] if fi not in shared]
        for fi in moved:
            f = faces[fi]
            wa = next(w for w in f if wedge_point[w] == a)  # type: ignore[union-attr]
            if wa not in wmap:
                return False  # a uv island / hard edge of a that b does not continue
        # No flips, in space or in uv.
        pb = pos[b]
        for fi in moved:
            f = faces[fi]
            p = [pos[wedge_point[w]] for w in f]  # type: ignore[union-attr]
            n0 = _cross(_sub(p[1], p[0]), _sub(p[2], p[0]))
            p2 = [pb if wedge_point[w] == a else pos[wedge_point[w]] for w in f]  # type: ignore[union-attr]
            n1 = _cross(_sub(p2[1], p2[0]), _sub(p2[2], p2[0]))
            l0, l1 = _norm(n0), _norm(n1)
            if l1 < 1e-12 or _dot(n0, n1) < min_normal_dot * l0 * l1:
                return False
            uv0 = [wedge_attr[w][3:5] for w in f]  # type: ignore[union-attr]
            uv1 = [wedge_attr[wmap[w]][3:5] if w in wmap else wedge_attr[w][3:5] for w in f]  # type: ignore[union-attr]
            a0 = _uv_area(*uv0)
            a1 = _uv_area(*uv1)
            if abs(a0) > 1e-12 and (a0 * a1 <= 0):
                return False
        # Apply.
        for fi in shared:
            f = faces[fi]
            for w in f:  # type: ignore[union-attr]
                pfaces[wedge_point[w]].discard(fi)
            faces[fi] = None
            alive -= 1
        for fi in moved:
            f = faces[fi]
            faces[fi] = [wmap[w] if w in wmap else w for w in f]  # type: ignore[union-attr]
            pfaces[b].add(fi)
        pfaces[a].clear()
        _add(Q[b], Q[a])
        removed[a] = True
        ver[b] += 1
        return True

    while alive > target and heap:
        _, a, b, va, vb = heapq.heappop(heap)
        if removed[a] or removed[b] or ver[a] != va or ver[b] != vb:
            continue
        if try_collapse(a, b):
            push_edges(b)

    # ---- compact --------------------------------------------------------------------------------
    out_index: dict[int, int] = {}
    out_vertices: list[Vertex] = []
    out_tris: list[tuple[int, int, int]] = []
    for f in faces:
        if f is None:
            continue
        tri = []
        for w in f:
            i = out_index.get(w)
            if i is None:
                i = len(out_vertices)
                out_index[w] = i
                p = pos[wedge_point[w]]
                at = wedge_attr[w]
                out_vertices.append((p[0], p[1], p[2], at[0], at[1], at[2], at[3], at[4]))
            tri.append(i)
        out_tris.append((tri[0], tri[1], tri[2]))
    return out_vertices, out_tris
