import * as THREE from 'three';
import type { MapBox, MapDefinition } from '@wd/shared';
import { addWetness } from './materials.ts';

const MARKET = { minX: 38, maxX: 170, minZ: -62, maxZ: 64 };
const STRIP_LIMIT = 26;
const SIGN_TEXTURE_WIDTH = 1024;

export interface NeonSignSpec {
  readonly label: string;
  readonly sublabel: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly w: number;
  readonly h: number;
  readonly color: number;
}

export const NEON_SIGNS: readonly NeonSignSpec[] = [
  {
    label: 'WARSZAWA 2030',
    sublabel: 'CENTRUM LINK',
    x: 58,
    y: 5.15,
    z: 0,
    yaw: 90,
    w: 8,
    h: 2.2,
    color: 0x5ee7ff,
  },
  {
    label: 'NOCNY RYNEK',
    sublabel: 'OPEN 24H',
    x: 93,
    y: 4.25,
    z: 45,
    yaw: 180,
    w: 4.2,
    h: 1.35,
    color: 0xff3dbd,
  },
  {
    label: 'UPLINK',
    sublabel: 'DRONE / RADAR',
    x: 125,
    y: 3.8,
    z: -33,
    yaw: -12,
    w: 3.25,
    h: 1.25,
    color: 0x8eff6a,
  },
  {
    label: 'METRO SRODMIESCIE',
    sublabel: 'M2 NIGHT LINE',
    x: 154,
    y: 4.6,
    z: 20,
    yaw: -92,
    w: 4.5,
    h: 1.42,
    color: 0xffb24a,
  },
];

interface StripPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly length: number;
  readonly color: THREE.Color;
}

const inMarket = (x: number, z: number): boolean =>
  x >= MARKET.minX && x <= MARKET.maxX && z >= MARKET.minZ && z <= MARKET.maxZ;

const boxVisible = (b: MapBox): boolean => b.visible !== false && b.dress !== 'pendant';

export function cssSrgbColor(hex: number): string {
  return `rgb(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255})`;
}

export function neonSignTextureSize(spec: NeonSignSpec): { width: number; height: number } {
  return {
    width: SIGN_TEXTURE_WIDTH,
    height: Math.round(SIGN_TEXTURE_WIDTH * (spec.h / spec.w)),
  };
}

export interface NeonSignTextLayout {
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly labelCenterY: number;
  readonly sublabelCenterY: number;
  readonly labelFontMax: number;
  readonly sublabelFontMax: number;
  readonly labelMaxWidth: number;
  readonly sublabelMaxWidth: number;
  readonly pad: number;
}

export function makeWetNeonMetalMaterial(
  color: number,
  roughness: number,
  metalness: number,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  addWetness(mat);
  return mat;
}

export function neonSignTextLayout(spec: NeonSignSpec): NeonSignTextLayout {
  const { width, height } = neonSignTextureSize(spec);
  const pad = Math.round(height * 0.075);
  return {
    textureWidth: width,
    textureHeight: height,
    labelCenterY: height * 0.43,
    sublabelCenterY: height * 0.66,
    labelFontMax: height * 0.27,
    sublabelFontMax: height * 0.13,
    labelMaxWidth: width - pad * 4.4,
    sublabelMaxWidth: width - pad * 5,
    pad,
  };
}

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  maxSize: number,
  maxWidth: number,
): number {
  let size = maxSize;
  do {
    ctx.font = `${weight} ${size}px Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  } while (size > 12);
  return size;
}

export function neonStripPlacements(map: Pick<MapDefinition, 'boxes'>): StripPlacement[] {
  const out: StripPlacement[] = [];
  for (const b of map.boxes) {
    if (out.length >= STRIP_LIMIT) break;
    if (!boxVisible(b) || !inMarket(b.center.x, b.center.z)) continue;
    if (b.size.y < 0.45 || b.size.x < 1.8) continue;
    if (!['container', 'paint', 'metal', 'tile', 'glass'].includes(b.mat)) continue;
    const yaw = THREE.MathUtils.degToRad(b.rot?.y ?? 0);
    const longX = b.size.x >= b.size.z;
    const length = Math.min(longX ? b.size.x : b.size.z, 7.5);
    if (length < 1.4) continue;
    const hue = out.length % 3;
    out.push({
      x: b.center.x,
      y: b.center.y + b.size.y * 0.5 + 0.035,
      z: b.center.z,
      yaw: yaw + (longX ? 0 : Math.PI * 0.5),
      length,
      color: new THREE.Color(hue === 0 ? 0x5ee7ff : hue === 1 ? 0xff3dbd : 0xffb24a),
    });
  }
  return out;
}

function makeTextTexture(spec: NeonSignSpec): THREE.Texture {
  if (typeof document === 'undefined') {
    const px = new Uint8Array([16, 32, 44, 220, 80, 231, 255, 240, 255, 61, 189, 220, 0, 0, 0, 0]);
    const texture = new THREE.DataTexture(px, 2, 2, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }
  const canvas = document.createElement('canvas');
  const size = neonSignTextureSize(spec);
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const glow = cssSrgbColor(spec.color);
  const layout = neonSignTextLayout(spec);
  const pad = layout.pad;
  ctx.fillStyle = 'rgba(3, 6, 13, 0.72)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  bg.addColorStop(0, 'rgba(255,255,255,0.08)');
  bg.addColorStop(0.5, 'rgba(255,255,255,0.015)');
  bg.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = bg;
  ctx.fillRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = Math.max(2, Math.round(canvas.height * 0.012));
  ctx.strokeRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2);
  ctx.strokeStyle = glow;
  ctx.lineWidth = Math.max(2, Math.round(canvas.height * 0.008));
  ctx.shadowColor = glow;
  ctx.shadowBlur = canvas.height * 0.045;
  ctx.strokeRect(pad * 1.55, pad * 1.55, canvas.width - pad * 3.1, canvas.height - pad * 3.1);
  ctx.shadowColor = glow;
  ctx.shadowBlur = canvas.height * 0.055;
  ctx.fillStyle = glow;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelSize = fitFont(ctx, spec.label, 760, layout.labelFontMax, layout.labelMaxWidth);
  ctx.font = `760 ${labelSize}px Arial, sans-serif`;
  ctx.fillText(spec.label, canvas.width / 2, layout.labelCenterY);
  ctx.shadowBlur = canvas.height * 0.032;
  const subSize = fitFont(ctx, spec.sublabel, 650, layout.sublabelFontMax, layout.sublabelMaxWidth);
  ctx.font = `650 ${subSize}px Arial, sans-serif`;
  ctx.fillText(spec.sublabel, canvas.width / 2, layout.sublabelCenterY);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  const scanStep = Math.max(6, Math.round(canvas.height * 0.045));
  for (let y = pad; y < canvas.height - pad; y += scanStep)
    ctx.fillRect(pad * 1.2, y, canvas.width - pad * 2.4, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let x = pad * 1.5; x < canvas.width - pad; x += Math.max(80, canvas.width / 9))
    ctx.fillRect(x, pad * 1.3, 2, canvas.height - pad * 2.6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function pose(object: THREE.Object3D, x: number, y: number, z: number, yaw: number): void {
  object.position.set(x, y, z);
  object.rotation.set(0, THREE.MathUtils.degToRad(yaw), 0);
}

export class NeonDistrict {
  readonly group = new THREE.Group();
  private readonly textures: THREE.Texture[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly signPanels: THREE.Mesh[] = [];
  private reflectionCards: THREE.InstancedMesh | null = null;
  private readonly reflectionMatrices: THREE.Matrix4[] = [];
  private readonly glowMap: THREE.DataTexture;
  private time = 0;

  constructor(map: MapDefinition) {
    const size = 32;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
        pixels[i + 3] = Math.round(
          255 *
            Math.sin((Math.PI * x) / (size - 1)) ** 2 *
            Math.sin((Math.PI * y) / (size - 1)) ** 2,
        );
      }
    }
    this.glowMap = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    this.glowMap.magFilter = THREE.LinearFilter;
    this.glowMap.minFilter = THREE.LinearFilter;
    this.glowMap.needsUpdate = true;
    this.textures.push(this.glowMap);
    this.group.name = 'neon-district';
    this.group.visible = false;
    this.buildStrips(map);
    this.buildSigns();
    this.buildReflections();
    this.buildProjectionBeams();
  }

  setEnabled(enabled: boolean): void {
    this.group.visible = enabled;
  }

  /** Replace a painted ground glow only after its actual irradiance texture is uploaded. */
  setBakedGroundSigns(labels: readonly string[]): void {
    const cards = this.reflectionCards;
    if (!cards) return;
    const matrix = new THREE.Matrix4();
    const zero = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < NEON_SIGNS.length; i++) {
      matrix.copy(this.reflectionMatrices[i]!);
      if (labels.includes(NEON_SIGNS[i]!.label)) matrix.scale(zero);
      cards.setMatrixAt(i, matrix);
    }
    cards.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    if (!this.group.visible) return;
    this.time += dt;
    for (let i = 0; i < this.signPanels.length; i++) {
      const mesh = this.signPanels[i]!;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.72 + Math.sin(this.time * 1.4 + i * 1.7) * 0.06;
    }
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.group.clear();
  }

  private remember<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }

  private buildStrips(map: MapDefinition): void {
    const strips = neonStripPlacements(map);
    if (!strips.length) return;
    const geo = this.remember(new THREE.BoxGeometry(1, 0.045, 0.07));
    const mat = this.mat(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        toneMapped: false,
        fog: true,
      }),
    );
    const mesh = new THREE.InstancedMesh(geo, mat, strips.length);
    mesh.name = 'neon-mounted-strips';
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i]!;
      quat.setFromEuler(new THREE.Euler(0, s.yaw, 0));
      scale.set(s.length, 1, 1);
      matrix.compose(new THREE.Vector3(s.x, s.y, s.z), quat, scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, s.color);
    }
    this.group.add(mesh);
  }

  private buildSigns(): void {
    const panelGeo = this.remember(new THREE.PlaneGeometry(1, 1));
    const housingGeo = this.remember(new THREE.BoxGeometry(1, 1, 0.08));
    const supportGeo = this.remember(new THREE.BoxGeometry(0.055, 1, 0.055));
    const hardwareGeo = this.remember(new THREE.BoxGeometry(1, 1, 1));
    const housingMat = this.mat(makeWetNeonMetalMaterial(0x101722, 0.72, 0.65));
    const supportMat = this.mat(makeWetNeonMetalMaterial(0x11151c, 0.6, 0.8));

    const housings = new THREE.InstancedMesh(housingGeo, housingMat, NEON_SIGNS.length);
    housings.name = 'neon-sign-housings';
    const supports = new THREE.InstancedMesh(supportGeo, supportMat, NEON_SIGNS.length * 2);
    supports.name = 'neon-sign-supports';
    const hardware = new THREE.InstancedMesh(hardwareGeo, supportMat, NEON_SIGNS.length * 10);
    hardware.name = 'neon-sign-frame-hardware';
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    let supportIndex = 0;
    let hardwareIndex = 0;
    for (let i = 0; i < NEON_SIGNS.length; i++) {
      const spec = NEON_SIGNS[i]!;
      const yaw = THREE.MathUtils.degToRad(spec.yaw);
      const texture = makeTextTexture(spec);
      this.textures.push(texture);
      const panelMat = this.mat(
        new THREE.MeshBasicMaterial({
          map: texture,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
          depthTest: true,
          toneMapped: false,
          fog: true,
          side: THREE.DoubleSide,
        }),
      );
      const panel = new THREE.Mesh(panelGeo, panelMat);
      panel.name = `hologram-${spec.label.toLowerCase().replaceAll(' ', '-')}`;
      pose(panel, spec.x, spec.y, spec.z, spec.yaw);
      panel.scale.set(spec.w, spec.h, 1);
      this.signPanels.push(panel);
      this.group.add(panel);

      quat.setFromEuler(new THREE.Euler(0, yaw, 0));
      const normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      matrix.compose(
        new THREE.Vector3(spec.x - normal.x * 0.055, spec.y, spec.z - normal.z * 0.055),
        quat,
        scale.set(spec.w + 0.22, spec.h + 0.18, 1),
      );
      housings.setMatrixAt(i, matrix);
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const mountY = 2.05;
      const supportTop = spec.y + spec.h * 0.5 + 0.12;
      const supportHeight = supportTop - mountY;
      for (const side of [-1, 1] as const) {
        matrix.compose(
          new THREE.Vector3(
            spec.x + right.x * side * (spec.w * 0.5 + 0.18),
            mountY + supportHeight * 0.5,
            spec.z + right.z * side * (spec.w * 0.5 + 0.18),
          ),
          quat,
          scale.set(1, supportHeight, 1),
        );
        supports.setMatrixAt(supportIndex++, matrix);
      }
      for (const y of [-1, 1] as const) {
        matrix.compose(
          new THREE.Vector3(
            spec.x + normal.x * 0.035,
            spec.y + y * (spec.h * 0.5 + 0.075),
            spec.z + normal.z * 0.035,
          ),
          quat,
          scale.set(spec.w + 0.28, 0.055, 0.055),
        );
        hardware.setMatrixAt(hardwareIndex++, matrix);
      }
      for (const x of [-1, 1] as const) {
        matrix.compose(
          new THREE.Vector3(
            spec.x + right.x * x * (spec.w * 0.5 + 0.115) + normal.x * 0.035,
            spec.y,
            spec.z + right.z * x * (spec.w * 0.5 + 0.115) + normal.z * 0.035,
          ),
          quat,
          scale.set(0.055, spec.h + 0.2, 0.055),
        );
        hardware.setMatrixAt(hardwareIndex++, matrix);
      }
      for (const x of [-1, 1] as const) {
        for (const y of [-1, 1] as const) {
          matrix.compose(
            new THREE.Vector3(
              spec.x + right.x * x * (spec.w * 0.5 + 0.16),
              spec.y + y * (spec.h * 0.5 + 0.095),
              spec.z + right.z * x * (spec.w * 0.5 + 0.16),
            ),
            quat,
            scale.set(0.13, 0.13, 0.04),
          );
          matrix.setPosition(
            matrix.elements[12] + normal.x * 0.035,
            matrix.elements[13],
            matrix.elements[14] + normal.z * 0.035,
          );
          hardware.setMatrixAt(hardwareIndex++, matrix);
        }
      }
      for (const x of [-1, 1] as const) {
        matrix.compose(
          new THREE.Vector3(
            spec.x + right.x * x * (spec.w * 0.31),
            spec.y - spec.h * 0.5 - 0.145,
            spec.z + right.z * x * (spec.w * 0.31),
          ),
          quat,
          scale.set(0.18, 0.045, 0.08),
        );
        matrix.setPosition(
          matrix.elements[12] + normal.x * 0.035,
          matrix.elements[13],
          matrix.elements[14] + normal.z * 0.035,
        );
        hardware.setMatrixAt(hardwareIndex++, matrix);
      }
    }
    this.group.add(housings, supports, hardware);
  }

  private buildReflections(): void {
    const geo = this.remember(new THREE.PlaneGeometry(1, 1));
    const mat = this.mat(
      new THREE.MeshBasicMaterial({
        map: this.glowMap,
        color: 0xffffff,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        depthTest: true,
        vertexColors: true,
        toneMapped: false,
      }),
    );
    const mesh = new THREE.InstancedMesh(geo, mat, NEON_SIGNS.length);
    mesh.name = 'neon-wet-reflection-cards';
    this.reflectionCards = mesh;
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.5, 0, 0));
    const scale = new THREE.Vector3();
    for (let i = 0; i < NEON_SIGNS.length; i++) {
      const spec = NEON_SIGNS[i]!;
      matrix.compose(
        new THREE.Vector3(spec.x, 0.018, spec.z),
        quat,
        scale.set(spec.w * 0.95, spec.w * 0.42, 1),
      );
      mesh.setMatrixAt(i, matrix);
      this.reflectionMatrices.push(matrix.clone());
      mesh.setColorAt(i, new THREE.Color(spec.color));
    }
    this.group.add(mesh);
  }

  private buildProjectionBeams(): void {
    const geo = this.remember(new THREE.PlaneGeometry(2.4, 8));
    const mat = this.mat(
      new THREE.MeshBasicMaterial({
        map: this.glowMap,
        color: 0x5ee7ff,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
        fog: true,
        side: THREE.DoubleSide,
      }),
    );
    const mesh = new THREE.InstancedMesh(geo, mat, 6);
    mesh.name = 'neon-uplink-projection-beams';
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const beacons = [
      { x: 105, y: 4.4, z: 0, sx: 0.8, sz: 0.8 },
      { x: 57, y: 4.1, z: -43, sx: 0.5, sz: 0.5 },
      { x: 153, y: 4.9, z: 20, sx: 0.62, sz: 0.62 },
    ] as const;
    let index = 0;
    for (let i = 0; i < beacons.length; i++) {
      const b = beacons[i]!;
      for (const yaw of [0, Math.PI * 0.5] as const) {
        quat.setFromEuler(new THREE.Euler(0, yaw, 0));
        matrix.compose(new THREE.Vector3(b.x, b.y, b.z), quat, scale.set(b.sx, 1, b.sz));
        mesh.setMatrixAt(index++, matrix);
      }
    }
    this.group.add(mesh);
  }
}
