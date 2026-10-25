import { describe, expect, it } from 'vitest';
import {
  palaceOrnamentVisibility,
  palaceReliefVisibility,
  PALACE_RELIEF_SHADE,
  palaceRevealLuminanceRatio,
  palaceCourseShadowLength,
} from './palaceCavity.ts';
import { sunDirection, WEATHER_PRESETS } from './weather.ts';
import { FACADE_STYLES } from './facadeRelief.ts';

describe('Palace cavity visibility', () => {
  it('keeps exposed lips and upward stone open to the sky while sheltering recesses', () => {
    for (const axis of ['o', 's', 'y'] as const) {
      for (const sign of [-1, 1] as const) {
        expect(palaceReliefVisibility(axis, sign, 0)).toBe(1);
        expect(palaceReliefVisibility(axis, sign, -1)).toBe(1);
      }
    }
    expect(palaceReliefVisibility('o', 1, 0.22 / 0.3)).toBeCloseTo(0.817, 3);
    expect(palaceReliefVisibility('s', 1, 1)).toBeCloseTo(0.45);
    expect(palaceReliefVisibility('s', -1, 1)).toBeCloseTo(0.45);
    expect(palaceReliefVisibility('y', -1, 1)).toBeCloseTo(0.36);
    expect(palaceReliefVisibility('y', 1, 1)).toBeCloseTo(0.91);
  });

  it('keeps depth gradients monotonic and bounded inside the authored recess', () => {
    for (const axis of ['o', 's', 'y'] as const) {
      for (const sign of [-1, 1] as const) {
        let previous = 1;
        for (const inset of [0, 0.2, 0.5, 0.8, 1, 2]) {
          const visibility = palaceReliefVisibility(axis, sign, inset);
          expect(visibility).toBeLessThanOrEqual(previous);
          expect(visibility).toBeGreaterThanOrEqual(0.35);
          previous = visibility;
        }
      }
    }
  });

  it('shades crown undersides without darkening vertical clock faces or the spire slopes', () => {
    expect(palaceOrnamentVisibility(-1)).toBeCloseTo(0.72);
    expect(palaceOrnamentVisibility(-0.5)).toBeCloseTo(0.86);
    for (const normalY of [0, 0.05, 0.7, 1]) expect(palaceOrnamentVisibility(normalY)).toBe(1);
    expect(palaceOrnamentVisibility(-2)).toBeCloseTo(0.72);
  });
});

// Golden east facade: 18 degree elevation, sun 45 degrees across the face.
describe('Palace analytic relief at playing distance', () => {
  const golden = WEATHER_PRESETS.golden;
  const sun = sunDirection(golden.sunElevation, golden.sunAzimuth);
  // East-facing wall N=(1,0,0), its authored along-wall tangent T=(0,0,1).
  const facing = sun.x;
  const shadowJambAway = 0.5 + 0.5 * sun.z;
  const projection = FACADE_STYLES.monumental.course.o - FACADE_STYLES.monumental.field;

  it('makes the shadow jamb and soffit at least 45 percent darker than the wall', () => {
    for (const away of [shadowJambAway, sun.y >= 0 ? 1 : 0]) {
      const ratio = palaceRevealLuminanceRatio(PALACE_RELIEF_SHADE.depth, away);
      expect(ratio).toBeLessThanOrEqual(0.55);
      // Gamma-2.2 display proxy; the real GPU/AgX acceptance remains separate.
      expect(ratio ** (1 / 2.2)).toBeLessThanOrEqual(0.55);
    }
    expect(palaceRevealLuminanceRatio(0, 1)).toBe(1);
    expect(palaceRevealLuminanceRatio(PALACE_RELIEF_SHADE.depth, 0)).toBeGreaterThan(
      palaceRevealLuminanceRatio(PALACE_RELIEF_SHADE.depth, 1),
    );
  });

  it('keeps a 3-4 pixel reveal at 40 metres on a 1600x900, 90 degree horizontal view', () => {
    const pixelsPerMetre = 800 / 40;
    expect(PALACE_RELIEF_SHADE.jamb * pixelsPerMetre).toBeGreaterThanOrEqual(4);
    expect(PALACE_RELIEF_SHADE.head * pixelsPerMetre).toBeGreaterThanOrEqual(3);
  });

  it('keeps every shipped weather projection finite and bounded, including unlit east walls', () => {
    for (const preset of Object.values(WEATHER_PRESETS)) {
      const direction = sunDirection(preset.sunElevation, preset.sunAzimuth);
      const drop = palaceCourseShadowLength(projection, direction.y, direction.x);
      expect(Number.isFinite(drop)).toBe(true);
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(drop).toBeLessThanOrEqual(PALACE_RELIEF_SHADE.courseMax);
      if (direction.x <= 0) expect(drop).toBe(0);
    }
  });

  it('projects a horizontal ledge onto a vertical wall, with finite grazing/night limits', () => {
    const drop = palaceCourseShadowLength(projection, sun.y, facing);
    expect(drop).toBeCloseTo(0.080415, 5);
    expect(palaceCourseShadowLength(0.175, 0, facing)).toBe(0);
    expect(palaceCourseShadowLength(0.175, 0.3, -0.5)).toBe(0);
    expect(palaceCourseShadowLength(0.175, -0.3, facing)).toBe(0);
    expect(palaceCourseShadowLength(0.175, 1, 0.00001)).toBeLessThanOrEqual(0.65);
    expect(palaceCourseShadowLength(0, 1, 1)).toBe(0);
  });
});
