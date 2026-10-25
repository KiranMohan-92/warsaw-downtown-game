import { describe, expect, it } from 'vitest';
import { cmPer360, DEFAULT_SETTINGS, sanitizeSettings, verticalFov, WEATHERS } from './settings.ts';

describe('settings', () => {
  it('cm/360 matches the Source convention', () => {
    // 800 DPI, sens 1 → 360 / 0.022 = 16363.6 counts → 51.95 cm
    expect(cmPer360({ sensitivity: 1, mouseDpi: 800 })).toBeCloseTo(51.95, 1);
    expect(cmPer360({ sensitivity: 2, mouseDpi: 800 })).toBeCloseTo(25.98, 1);
  });

  it('90° horizontal at 16:9 is ~58.7° vertical', () => {
    expect(verticalFov(90)).toBeCloseTo(58.72, 1);
  });

  it('sanitizes garbage back into legal ranges', () => {
    const s = sanitizeSettings({
      sensitivity: 1e9,
      fov: 'wide',
      crouchMode: 'sometimes',
      crosshairColor: 'red;}',
      invertY: 'yes',
    });
    expect(s.sensitivity).toBe(20);
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(s.crouchMode).toBe('hold');
    expect(s.crosshairColor).toBe(DEFAULT_SETTINGS.crosshairColor);
    expect(s.invertY).toBe(false);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults to golden hour; the older presets (sunny, neon) stay valid', () => {
    expect(WEATHERS).toContain('neon');
    expect(DEFAULT_SETTINGS.weather).toBe('golden');
    expect(sanitizeSettings({ weather: 'neon' }).weather).toBe('neon');
    // A player who saved Sunny keeps it: the new default only applies to fresh settings.
    expect(sanitizeSettings({ weather: 'sunny' }).weather).toBe('sunny');
    expect(sanitizeSettings({ weather: 'night-city' }).weather).toBe(DEFAULT_SETTINGS.weather);
  });

  it('binds Inspect to a key no other default uses (F is Block)', () => {
    const inspect = DEFAULT_SETTINGS.keybinds.inspect;
    expect(inspect[0]).toBe('KeyY');
    for (const [action, codes] of Object.entries(DEFAULT_SETTINGS.keybinds)) {
      if (action === 'inspect') continue;
      expect(codes, action).not.toContain(inspect[0]);
    }
    expect(DEFAULT_SETTINGS.keybinds.block).toContain('KeyF');
  });

  it("never gives a new action's default key away from binds the player already saved", () => {
    const saved = { ...DEFAULT_SETTINGS.keybinds, smoke: ['KeyY', ''] } as Record<string, unknown>;
    delete saved.inspect;
    const s = sanitizeSettings({ keybinds: saved });
    expect(s.keybinds.smoke[0]).toBe('KeyY');
    expect(s.keybinds.inspect).toEqual(['', '']);
    // Saved binds that leave Y free get the default.
    const free = { ...DEFAULT_SETTINGS.keybinds } as Record<string, unknown>;
    delete free.inspect;
    expect(sanitizeSettings({ keybinds: free }).keybinds.inspect[0]).toBe('KeyY');
  });
});
