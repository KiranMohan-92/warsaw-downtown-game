import type * as THREE from 'three';

export interface ShadowGeometryStats {
  calls: number;
  triangles: number;
  reset(): void;
}

/** CPU counters only: no GPU queries, extra draw, or traversal of visible meshes. */
export function trackShadowGeometry(renderer: {
  info: { render: { calls: number; triangles: number } };
  shadowMap: Pick<THREE.WebGLShadowMap, 'render'>;
}): ShadowGeometryStats {
  const stats: ShadowGeometryStats = {
    calls: 0,
    triangles: 0,
    reset() {
      this.calls = 0;
      this.triangles = 0;
    },
  };
  const render = renderer.shadowMap.render.bind(renderer.shadowMap);
  renderer.shadowMap.render = (lights, scene, camera) => {
    const { calls, triangles } = renderer.info.render;
    render(lights, scene, camera);
    stats.calls += renderer.info.render.calls - calls;
    stats.triangles += renderer.info.render.triangles - triangles;
  };
  return stats;
}
