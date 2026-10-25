/**
 * The skateboard (Kiran): a near-future street deck (kicktails, grip tape, graphite underside with
 * a cyan underglow strip, metal trucks, translucent wheels), built procedurally (no downloads). One
 * lying at its spot (or where its rider fell) and one under each rider's feet, oriented along
 * their motion. Presentation only: sim/skateboard.ts owns who rides it.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Deck top above the ground (m): riders stand this much higher. */
export const DECK_HEIGHT = 0.1;

const LENGTH = 0.8;
const WIDTH = 0.21;

function deckGeometry(): THREE.BufferGeometry {
  // Rounded-end outline in XY, extruded (thickness), then laid flat with the length along +Z.
  const s = new THREE.Shape();
  const hl = LENGTH / 2;
  const hw = WIDTH / 2;
  s.moveTo(-hw, -hl + hw);
  s.lineTo(-hw, hl - hw);
  s.absarc(0, hl - hw, hw, Math.PI, 0, true);
  s.lineTo(hw, -hl + hw);
  s.absarc(0, -hl + hw, hw, 0, Math.PI, true);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 2,
    curveSegments: 12,
  });
  g.rotateX(-Math.PI / 2); // outline XY → XZ, thickness up
  // Kicktails: both ends curve up.
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const k = Math.max(0, Math.abs(z) - 0.27);
    p.setY(i, p.getY(i) + k * k * 2.6);
  }
  g.computeVertexNormals();
  return g;
}

function gripTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  x.fillStyle = '#1c1d1f';
  x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2200; i++) {
    const v = 20 + Math.floor(Math.random() * 30);
    x.fillStyle = `rgb(${v},${v},${v + 2})`;
    x.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let shared: {
  deck: THREE.BufferGeometry;
  grip: THREE.MeshStandardMaterial;
  under: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  wheel: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  truck: THREE.BufferGeometry;
  wheelGeo: THREE.BufferGeometry;
  strip: THREE.BufferGeometry;
} | null = null;

function parts(): NonNullable<typeof shared> {
  shared ??= {
    deck: deckGeometry(),
    grip: new THREE.MeshStandardMaterial({
      name: 'board:grip',
      map: gripTexture(),
      roughness: 0.95,
    }),
    under: new THREE.MeshStandardMaterial({ color: '#2b3033', roughness: 0.35, metalness: 0.3 }),
    metal: new THREE.MeshStandardMaterial({ color: '#8c9297', roughness: 0.35, metalness: 0.9 }),
    wheel: new THREE.MeshStandardMaterial({ color: '#bfe9f2', roughness: 0.4, metalness: 0 }),
    glow: new THREE.MeshStandardMaterial({
      color: '#39e0ff',
      emissive: new THREE.Color('#39e0ff'),
      emissiveIntensity: 2.2,
      roughness: 0.3,
    }),
    truck: new THREE.BoxGeometry(0.17, 0.028, 0.05),
    wheelGeo: new THREE.CylinderGeometry(0.028, 0.028, 0.032, 16).rotateZ(Math.PI / 2),
    strip: new THREE.BoxGeometry(0.05, 0.004, 0.46),
  };
  return shared;
}

/** One board, length along local +Z, wheels on the ground at y = 0. */
export function buildSkateboard(): THREE.Group {
  const p = parts();
  const g = new THREE.Group();
  g.name = 'skateboard';
  const deckY = DECK_HEIGHT - 0.015;
  const deck = new THREE.Mesh(p.deck, [p.grip, p.under]);
  // ExtrudeGeometry groups: 0 = caps (top/bottom), 1 = sides; the caps get the grip.
  deck.position.y = deckY;
  const strip = new THREE.Mesh(p.strip, p.glow);
  strip.position.y = deckY - 0.004;
  g.add(deck, strip);
  // Trucks and wheels merged per material (2 draws, not 6); only the deck casts a shadow.
  const trucks: THREE.BufferGeometry[] = [];
  const wheels: THREE.BufferGeometry[] = [];
  for (const z of [-0.26, 0.26]) {
    trucks.push(p.truck.clone().translate(0, 0.05, z));
    for (const x of [-0.075, 0.075]) wheels.push(p.wheelGeo.clone().translate(x, 0.028, z));
  }
  g.add(
    new THREE.Mesh(mergeGeometries(trucks), p.metal),
    new THREE.Mesh(mergeGeometries(wheels), p.wheel),
  );
  deck.castShadow = true;
  return g;
}

/** Point a board along a horizontal velocity (keeps its heading when nearly still). */
export function aimBoard(board: THREE.Object3D, vx: number, vz: number, fallbackYaw: number): void {
  if (Math.hypot(vx, vz) > 0.3) board.rotation.y = Math.atan2(vx, vz);
  else if (!board.userData.aimed) board.rotation.y = fallbackYaw;
  board.userData.aimed = true;
}
