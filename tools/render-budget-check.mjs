// Portable CPU regressions: node tools/render-budget-check.mjs. This does not measure GPU FPS.
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./render-budget-loader.mjs', import.meta.url);

const THREE = await import('../packages/client/node_modules/three/build/three.module.js');
const { bushArchetype, grassArchetype } =
  await import('../packages/client/src/render/foliageGeometry.ts');
const {
  buildClumps,
  buildTrees,
  foliageMaterials,
  setFoliageQuality,
  updateFoliage,
  warmFoliage,
  FOLIAGE_CARD_FADE,
  FOLIAGE_TREE_NEAR_DISTANCE,
  FOLIAGE_LOD_HYSTERESIS,
} = await import('../packages/client/src/render/foliageMesh.ts');
const { budgetShadows, setRenderBudget } =
  await import('../packages/client/src/render/renderBudget.ts');
const { WeatherSystem, WEATHER_PRESETS } = await import('../packages/client/src/render/weather.ts');
let assertions = 0;
const check = (value, message) => {
  assertions++;
  assert(value, message);
};

// Rays near the analytic cylinder edge and crown must hit opaque triangles, independent of alpha.
for (const make of [bushArchetype, grassArchetype]) {
  const geometry = make().toGeometry();
  const flags = geometry.getAttribute('aFoliage');
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  for (let a = 0; a < 24; a++) {
    const angle = (a * Math.PI) / 12;
    const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    for (const offset of [-0.999, -0.98, -0.955, -0.7, 0, 0.7, 0.955, 0.98, 0.999]) {
      for (const y of [0.01, 0.1, 0.5, 0.9, 0.99]) {
        const from = dir.clone().multiplyScalar(-3).addScaledVector(side, offset).setY(y);
        const hits = new THREE.Raycaster(from, dir, 0, 6).intersectObject(mesh);
        check(
          hits.some(({ face }) => [face.a, face.b, face.c].every((i) => flags.getZ(i) >= 0.5)),
          `${make.name} concealment hole at angle=${angle}, offset=${offset}, height=${y}`,
        );
      }
    }
    for (const radius of [0, 0.8, 0.999]) {
      for (const sign of [-1, 1]) {
        const from = new THREE.Vector3(
          Math.cos(angle) * radius,
          sign > 0 ? -1 : 2,
          Math.sin(angle) * radius,
        );
        const hits = new THREE.Raycaster(from, new THREE.Vector3(0, sign, 0), 0, 4).intersectObject(
          mesh,
        );
        check(
          hits.some(({ face }) => [face.a, face.b, face.c].every((i) => flags.getZ(i) >= 0.5)),
          `${make.name} missing opaque cap at angle=${angle}, radius=${radius}`,
        );
      }
    }
  }
  geometry.dispose();
  mesh.material.dispose();
}
check(
  FOLIAGE_CARD_FADE[1] <= FOLIAGE_TREE_NEAR_DISTANCE - FOLIAGE_LOD_HYSTERESIS,
  'Cards must finish fading before either direction of the tree LOD switch',
);

// Low selects only opaque triangles; quality and distance cannot remove any plant.
const root = new THREE.Group();
root.add(
  buildTrees([
    { kind: 'broadleaf', x: 0, z: 0, height: 12, crown: 4 },
    { kind: 'conifer', x: 12, z: 0, height: 14, crown: 4 },
  ]),
  buildClumps([
    { kind: 'bush', x: 0, z: 0, r: 2, h: 1.5 },
    { kind: 'grass', x: 8, z: 0, r: 1.5, h: 1.8 },
  ]),
);
root.updateMatrixWorld(true);
for (const tier of ['low', 'medium', 'high', 'low']) {
  setFoliageQuality(tier);
  const { lit, depth } = foliageMaterials();
  check((lit.alphaTest === 0) === (tier === 'low'), 'Low colour pass must disable alpha test');
  check((depth.alphaTest === 0) === (tier === 'low'), 'Low shadow pass must disable alpha test');
  for (const x of [0, 32, 44, 48, 52, 72, 500, 48, 0]) {
    updateFoliage(root, new THREE.Vector3(x, 1.7, 0));
    let draws = 0;
    root.traverseVisible((mesh) => {
      if (!(mesh instanceof THREE.Mesh)) return;
      draws++;
      if (tier === 'low') {
        const flags = mesh.geometry.getAttribute('aFoliage');
        const index = mesh.geometry.index;
        for (let i = 0; i < index.count; i++)
          check(flags.getZ(index.getX(i)) >= 0.5, 'Low drew a leaf card');
      }
    });
    check(draws === 4, 'Foliage must keep one draw per plant kind with no LOD overlap/hole');
  }
}

const scene = new THREE.Scene();
const normal = new THREE.Texture();
const material = new THREE.MeshStandardMaterial({ normalMap: normal });
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [material, material]));
material.onBeforeCompile = (shader) => {
  shader.uniforms.existing = { value: 7 };
};
material.customProgramCacheKey = () => 'existing';
setRenderBudget(scene, 'low');
check(material.normalMap === null && budgetShadows.value === 1, 'Low normal/shadow budget');
const shader = {
  uniforms: {},
  vertexShader: '',
  fragmentShader: '#include <common>\n#include <shadowmap_pars_fragment>',
};
material.onBeforeCompile(shader, {});
check(shader.uniforms.existing.value === 7, 'Budget patch lost the material hook');
check(
  shader.fragmentShader.includes('texture( shadowMap, shadowCoord.xyz )'),
  'Missing single PCF lookup',
);
check(shader.uniforms.uBudgetShadows === budgetShadows, 'Shadow tier must be a shared uniform');
setRenderBudget(scene, 'medium');
check(material.normalMap === normal, 'Normal map must restore by identity');
const version = material.version;
setRenderBudget(scene, 'high');
check(
  material.version === version && budgetShadows.value === 0,
  'Higher tiers must not recompile for shadow filtering',
);

const hemi = new THREE.HemisphereLight();
const environment = new THREE.Texture();
const weather = new WeatherSystem({
  scene,
  hemi,
  sun: new THREE.DirectionalLight(),
  sky: { set() {}, setExposure() {}, setFlash() {}, bakeEnvironment: () => environment },
  rain: { setIntensity() {} },
  setBloom() {},
  onThunder() {},
  setRainAudio() {},
});
weather.setEnvironments({ get: () => environment });
let maxFogError = 0;
for (const [id, preset] of Object.entries(WEATHER_PRESETS)) {
  weather.apply(id);
  weather.setLowQuality(false);
  const higher = hemi.color.clone().multiplyScalar(hemi.intensity);
  weather.setLowQuality(true);
  check(
    scene.environment === null && weather.environmentMap === environment,
    'Low world / weapon environment split',
  );
  check(
    hemi.color.r * hemi.intensity > higher.r,
    'Low must replace the removed diffuse irradiance',
  );
  check(scene.fog instanceof THREE.Fog, 'Low must use cheap depth fog');
  for (let depth = 0; depth <= 1500; depth += 0.5) {
    const expected = 1 - Math.exp(-Math.pow(preset.fogDensity * depth, 2));
    const actual = THREE.MathUtils.smoothstep(depth, scene.fog.near, scene.fog.far);
    const error = Math.abs(expected - actual);
    check(error < 0.036, 'Low fog changed the distance gradient too much');
    maxFogError = Math.max(maxFogError, error);
  }
  weather.update(0.01);
  weather.setLowQuality(false);
  check(
    scene.environment === environment && scene.fog instanceof THREE.FogExp2,
    'Higher tier lighting/fog restoration',
  );
  check(
    Math.abs(hemi.intensity - preset.hemiIntensity * preset.exposure) < 1e-8,
    'Hemisphere restoration',
  );
}

let target = null;
const permutations = new Set();
const renderer = {
  toneMapping: THREE.AgXToneMapping,
  initTexture() {},
  getRenderTarget: () => target,
  getActiveCubeFace: () => 0,
  getActiveMipmapLevel: () => 0,
  setRenderTarget(next) {
    target = next;
  },
  async compileAsync(proxies) {
    for (const mesh of proxies.children) {
      check(!!mesh.geometry.getAttribute('aFoliageRoot'), 'Warm proxy lacks foliage attributes');
      permutations.add(
        `${mesh.material.type}:${mesh instanceof THREE.InstancedMesh}:${mesh.material.alphaTest > 0}:${!!target}`,
      );
    }
  },
};
setFoliageQuality('low');
await warmFoliage(renderer, scene, new THREE.PerspectiveCamera());
check(permutations.size === 16, 'Must warm lit/depth, instanced/merged, opaque/alpha, canvas/HDR');
check(
  target === null && foliageMaterials().lit.alphaTest === 0,
  'Warm-up must restore the active tier/target',
);
setFoliageQuality('high');
console.log(
  JSON.stringify({
    status: 'pass',
    assertions,
    maxFogError,
    foliageWarmPermutations: permutations.size,
    gpuMeasured: false,
  }),
);
