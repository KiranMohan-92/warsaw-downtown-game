import { describe, expect, it } from 'vitest';
import { armouredWreck, helicopterWreck, tankWreck } from './props.ts';
import { getMap } from './registry.ts';
import { quatFromEulerDeg, rotateByQuat } from '../math/quat.ts';
import type { MapBox } from './types.ts';

/**
 * The CC BY wreck models (client render/heroModels.ts, models/vehicles/) are drawn at an
 * invisible, non-colliding anchor box at the prop's origin; every collision box is a `heroPart`
 * (mapMesh skips them; the hero fallback draws them if the model fails to load).
 */
describe('wreck heroes', () => {
  const cases: [string, (at: { x: number; z: number; rot?: number }) => MapBox[]][] = [
    ['heli_wreck', helicopterWreck],
    ['armoured_wreck', armouredWreck],
    ['tank_wreck', tankWreck],
  ];

  it.each(cases)(
    '%s: one anchor on the ground at the origin, every collider a heroPart',
    (id, make) => {
      const at = { x: 12, z: -7, rot: 40 };
      const boxes = make(at);
      const anchors = boxes.filter((b) => b.hero);
      expect(anchors).toHaveLength(1);
      const a = anchors[0]!;
      expect(a.hero).toBe(id);
      expect(a.collide).toBe(false);
      expect(a.visible).toBe(false);
      expect(a.center.x).toBeCloseTo(at.x, 6);
      expect(a.center.z).toBeCloseTo(at.z, 6);
      expect(a.center.y - a.size.y / 2).toBeCloseTo(0, 6); // heroMatrix = the box's bottom centre
      expect(a.rot?.y ?? 0).toBeCloseTo(at.rot, 6);
      const parts = boxes.filter((b) => !b.hero);
      expect(parts.length).toBeGreaterThan(0);
      for (const b of parts) {
        expect(b.heroPart).toBe(id);
        expect(b.collide).not.toBe(false);
      }
    },
  );

  it('the Market carries the helicopter and both armoured wrecks where Kiran approved them', () => {
    const anchors = getMap('defilad').boxes.filter(
      (b) => b.hero === 'heli_wreck' || b.hero === 'armoured_wreck' || b.hero === 'tank_wreck',
    );
    const at = (id: string, x: number, z: number) =>
      anchors.some((b) => b.hero === id && Math.hypot(b.center.x - x, b.center.z - z) < 1e-6);
    expect(at('heli_wreck', 74, 32)).toBe(true);
    // Moved off the truck lanes (Kiran, 2026-10-02): the spots the cars they replace were moved to.
    expect(at('armoured_wreck', 66, 13.6)).toBe(true);
    expect(at('armoured_wreck', 83, -25.5)).toBe(true);
    expect(at('tank_wreck', 72, -30)).toBe(true);
  });

  it('no street dressing stands inside a drawn armoured wreck (its colliders host no pieces)', () => {
    const map = getMap('defilad');
    const wrecks = map.boxes.filter((b) => b.hero === 'armoured_wreck');
    expect(wrecks.length).toBeGreaterThan(0);
    for (const w of wrecks)
      for (const d of map.decor ?? [])
        expect(Math.hypot(d.x - w.center.x, d.z - w.center.z), JSON.stringify(d)).toBeGreaterThan(
          3,
        );
  });

  it('the tank wreck blocks its drawn turret bustle (rounds no longer pass through it)', () => {
    const inside = (b: MapBox, p: { x: number; y: number; z: number }) => {
      const r = rotateByQuat(
        { x: p.x - b.center.x, y: p.y - b.center.y, z: p.z - b.center.z },
        { ...quatFromEulerDeg(b.rot), w: -quatFromEulerDeg(b.rot).w },
      );
      return (
        Math.abs(r.x) <= b.size.x / 2 &&
        Math.abs(r.y) <= b.size.y / 2 &&
        Math.abs(r.z) <= b.size.z / 2
      );
    };
    const boxes = tankWreck({ x: 0, z: 0 }).filter((b) => b.collide !== false);
    // The bustle in the model, to its rear plate (Codex: a +Z ray at x 3.1, y 2.7 met the mesh
    // at z −0.86 and no box). The full face check is tools/assets/test_wreck_rays.py.
    for (const p of [
      { x: 1.764, y: 2.603, z: -0.637 },
      { x: 2.3, y: 2.75, z: -0.85 },
      { x: 3.1, y: 2.7, z: -0.8 },
    ])
      expect(boxes.some((b) => inside(b, p))).toBe(true);
  });
});
