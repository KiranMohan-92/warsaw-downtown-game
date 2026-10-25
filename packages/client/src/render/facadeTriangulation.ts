/** Triangulate a convex CCW facade boundary, retaining its collinear edge vertices. */
export function triangulateFacadeBoundary(
  points: readonly (readonly [number, number, ...number[]])[],
): number[] {
  const ring = points.map((_, i) => i);
  const triangles: number[] = [];
  const turn = (a: number, b: number, c: number): number => {
    const p = points[a]!;
    const q = points[b]!;
    const r = points[c]!;
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  };
  if (ring.length < 3) throw new Error('Facade boundary needs at least three vertices');
  while (ring.length > 3) {
    let ear = -1;
    let smallest = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const area = turn(
        ring[(i + ring.length - 1) % ring.length]!,
        ring[i]!,
        ring[(i + 1) % ring.length]!,
      );
      // The smallest positive corner leaves a non-collinear remainder even when all
      // other vertices lie on one edge. Work in local doubles, before world rounding.
      if (area > 1e-12 && area < smallest) {
        ear = i;
        smallest = area;
      }
    }
    if (ear < 0) throw new Error('Facade boundary has no positive convex ear');
    triangles.push(
      ring[(ear + ring.length - 1) % ring.length]!,
      ring[ear]!,
      ring[(ear + 1) % ring.length]!,
    );
    ring.splice(ear, 1);
  }
  if (turn(ring[0]!, ring[1]!, ring[2]!) <= 1e-12) {
    throw new Error('Facade boundary left a degenerate triangle');
  }
  triangles.push(...ring);
  return triangles;
}
